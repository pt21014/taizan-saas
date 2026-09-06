/**
 * 用例 ⑧：真的把 `@taizan/wechatpay` 的 `WechatPayProvider` 装进来走一遍回调。
 *
 * 与 `payment.integration.spec.ts` 的分工：那边用 `FakeProvider`（整个渠道都是假的），
 * 证明的是**控制器**的四段流程；这边只有网络那一层是假的（`FakeWechatPayClient`），
 * 报文构造、RSA 验签、AES-256-GCM 解密、`sub_openid` 兼容全是真代码在跑，
 * 证明的是**装配**——真 Provider 插进这个控制器确实能通。
 *
 * 回调报文用与微信完全相同的算法自己造（抄 `wechatpay/src/callback.spec.ts` 的 `makeNotify`）：
 * 自己解自己写的假数据是测不出验签的。
 *
 * @packageDocumentation
 */

import 'reflect-metadata'
import { Global, Injectable, Module, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { IdempotencyService, InfraModule, type RedisClient } from '@taizan/nest-infra'
import { createFakeInfraDb, RecordingLogger } from '@taizan/nest-infra/testing'
import { PrismaService } from '@taizan/nest-prisma'
import { PLAN_ORDER_PREFIX, type CallbackEvent, type ProviderConfig } from '@taizan/payment-core'
import { FakeWechatPayClient, rsaSha256Sign, WechatPayProvider } from '@taizan/wechatpay'
import RedisMock from 'ioredis-mock'
import * as crypto from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PaymentHandler, type PaymentEventHandler } from './handlers'
import { PaymentModule } from './payment.module'
import { PAY_CALLBACK_IDEMPOTENCY_SCOPE } from './payment.options'
import { StaticProviderConfigResolver } from './provider.registry'

const API_V3_KEY = 'QyeFGD5fS4NWO3zwSCingv56HAoXhFma' // 正好 32 字节
const PUB_KEY_ID = 'PUB_KEY_ID_0117'
const OUT_TRADE_NO = `${PLAN_ORDER_PREFIX}-01JC0K3V7Q8ZP5R2M9YB4XN6TA`

@Injectable()
@PaymentHandler(PLAN_ORDER_PREFIX)
class PlanOrderHandler implements PaymentEventHandler {
  declare readonly prefix: string
  readonly paid: CallbackEvent[] = []

  async onPaid(event: CallbackEvent): Promise<void> {
    this.paid.push(event)
  }
}

let priv: string
let pub: string
let app: INestApplication
let handler: PlanOrderHandler
let idempotency: IdempotencyService

/** 用微信那套算法自己造一份回调：AES-256-GCM 加密 resource + RSA 签 `ts\nnonce\nbody\n`。 */
function makeNotify(
  resource: Record<string, unknown>,
  opts: { signWith?: string } = {},
): { headers: Record<string, string>; body: string } {
  const iv = 'abcdefghijkl'
  const aad = 'transaction'
  const cipher = crypto.createCipheriv('aes-256-gcm', API_V3_KEY, iv)
  cipher.setAAD(Buffer.from(aad))
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(resource), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const body = JSON.stringify({
    id: 'evt-1',
    create_time: '2026-09-05T18:00:00+08:00',
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext: enc.toString('base64'),
      associated_data: aad,
      nonce: iv,
    },
  })
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = 'NONCE123'
  return {
    headers: {
      'content-type': 'application/json',
      'Wechatpay-Timestamp': timestamp,
      'Wechatpay-Nonce': nonce,
      'Wechatpay-Signature': rsaSha256Sign(
        `${timestamp}\n${nonce}\n${body}\n`,
        opts.signWith ?? priv,
      ),
      'Wechatpay-Serial': PUB_KEY_ID,
    },
    body,
  }
}

function successResource(): Record<string, unknown> {
  return {
    out_trade_no: OUT_TRADE_NO,
    transaction_id: '4200001234202609051234567890',
    trade_state: 'SUCCESS',
    success_time: '2026-09-05T18:00:05+08:00',
    amount: { total: 9900, payer_total: 9900 },
    payer: { openid: 'oABC-real-openid' },
  }
}

beforeAll(async () => {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString()

  const cfg: ProviderConfig = {
    mode: 'DIRECT',
    appId: 'wxappid',
    credentials: {
      mchId: '1900009191',
      serialNo: 'MCH_SERIAL',
      privateKeyPem: priv,
      apiV3Key: API_V3_KEY,
      publicKeyId: PUB_KEY_ID,
      publicKeyPem: pub,
    },
  }

  const db = createFakeInfraDb()
  const logger = new RecordingLogger()

  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: db.prisma }],
    exports: [PrismaService],
  })
  class FakePrismaModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      FakePrismaModule,
      InfraModule.forRoot({
        redis: new RedisMock() as unknown as RedisClient,
        cronEnabled: false,
        queueEnabled: false,
        logger,
      }),
      PaymentModule.forRoot({
        providers: [new WechatPayProvider({ api: new FakeWechatPayClient() })],
        configResolver: new StaticProviderConfigResolver({ WECHAT: cfg }),
        apiBaseUrl: 'https://api.example.com',
        logger,
      }),
    ],
    providers: [PlanOrderHandler],
  }).compile()

  app = moduleRef.createNestApplication({ rawBody: true })
  await app.init()
  handler = app.get(PlanOrderHandler)
  idempotency = app.get(IdempotencyService)
})

afterAll(async () => {
  await app.close()
})

describe('WechatPayProvider 走统一回调控制器', () => {
  it('伪造签名（换一把私钥签）→ 400，处理器没被调，也没有幂等占位', async () => {
    const forger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const notify = makeNotify(successResource(), {
      signWith: forger.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    })

    const res = await request(app.getHttpServer())
      .post('/api/public/pay/wechat/notify')
      .set(notify.headers)
      .type('json')
      .send(notify.body)

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'FAIL' })
    expect(handler.paid).toHaveLength(0)
    await expect(
      idempotency.seen(PAY_CALLBACK_IDEMPOTENCY_SCOPE, '4200001234202609051234567890'),
    ).resolves.toBe(false)
  })

  it('真签名 → 200 {code:SUCCESS}，处理器拿到归一化后的事件', async () => {
    const notify = makeNotify(successResource())

    const res = await request(app.getHttpServer())
      .post('/api/public/pay/wechat/notify')
      .set(notify.headers)
      .type('json')
      .send(notify.body)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ code: 'SUCCESS', message: '成功' })
    expect(handler.paid).toHaveLength(1)
    expect(handler.paid[0]).toMatchObject({
      kind: 'PAY_SUCCESS',
      channel: 'WECHAT',
      outTradeNo: OUT_TRADE_NO,
      transactionId: '4200001234202609051234567890',
      amountCents: 9900,
      payer: { kind: 'openid', value: 'oABC-real-openid' },
    })
  })

  it('微信重推同一笔（新签名、同 transaction_id）→ 处理器不再被调', async () => {
    const notify = makeNotify(successResource())

    const res = await request(app.getHttpServer())
      .post('/api/public/pay/wechat/notify')
      .set(notify.headers)
      .type('json')
      .send(notify.body)

    expect(res.status).toBe(200)
    expect(handler.paid).toHaveLength(1)
  })
})
