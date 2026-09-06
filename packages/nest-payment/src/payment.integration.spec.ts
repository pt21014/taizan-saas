/**
 * 统一回调控制器的端到端行为（蓝图 §4.12 的验收清单）。
 *
 * 全部用例都走**真实的 HTTP 请求**打进真实的 Nest 应用：验签、幂等、归一化、路由
 * 一段都不跳。直接调 service 的测法能全绿，但它证明不了「回调进来之后会发生什么」。
 *
 * @packageDocumentation
 */

import 'reflect-metadata'
import { Global, Injectable, Module, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { AuditService } from '@taizan/nest-audit'
import { IdempotencyService, InfraModule, type RedisClient } from '@taizan/nest-infra'
import { createFakeInfraDb, RecordingLogger, type FakeInfraDb } from '@taizan/nest-infra/testing'
import { PrismaService } from '@taizan/nest-prisma'
import { buildOutTradeNo, PLAN_ORDER_PREFIX, type CallbackEvent } from '@taizan/payment-core'
import RedisMock from 'ioredis-mock'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FakePaymentTestKit } from './fake.provider'
import { PaymentHandler, type PaymentEventHandler } from './handlers'
import { PaymentModule } from './payment.module'
import { PAY_CALLBACK_IDEMPOTENCY_SCOPE } from './payment.options'
import { PaymentService } from './payment.service'

/** 套餐订单处理器。`declare` 让 TS 满意，真正的 prefix 由 `@PaymentHandler` 定义在原型上。 */
@Injectable()
@PaymentHandler(PLAN_ORDER_PREFIX)
class PlanOrderHandler implements PaymentEventHandler {
  declare readonly prefix: string
  readonly paid: CallbackEvent[] = []
  /** 下一次 `onPaid` 抛错（模拟「发权益的事务挂了」）。 */
  failNext = false

  async onPaid(event: CallbackEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('发放套餐权益失败：数据库连接断了')
    }
    this.paid.push(event)
  }
}

interface Harness {
  app: INestApplication
  kit: FakePaymentTestKit
  payment: PaymentService
  handler: PlanOrderHandler
  idempotency: IdempotencyService
  db: FakeInfraDb
  logger: RecordingLogger
}

async function createHarness(): Promise<Harness> {
  const db = createFakeInfraDb()
  const logger = new RecordingLogger()

  // @Global：PaymentNotifyController 住在 PaymentModule 里，它 @Optional() 注入的
  // AuditService 必须在**它自己的**模块上下文里解析得到，放在根 providers 里够不着。
  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: db.prisma }, AuditService],
    exports: [PrismaService, AuditService],
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
        useFake: true,
        apiBaseUrl: 'https://api.example.com',
        logger,
      }),
    ],
    providers: [PlanOrderHandler],
  }).compile()

  // rawBody: true 是验签的前提——拿解析后的对象再 stringify 回来，键序和空白都对不上。
  const app = moduleRef.createNestApplication({ rawBody: true })
  await app.init()

  return {
    app,
    kit: app.get(FakePaymentTestKit),
    payment: app.get(PaymentService),
    handler: app.get(PlanOrderHandler),
    idempotency: app.get(IdempotencyService),
    db,
    logger,
  }
}

describe('统一支付回调控制器', () => {
  let h: Harness

  beforeEach(async () => {
    h = await createHarness()
  })

  afterEach(async () => {
    await h.app.close()
  })

  async function placeOrder(prefix: string = PLAN_ORDER_PREFIX): Promise<string> {
    const outTradeNo = buildOutTradeNo(prefix)
    await h.payment.createOrder({
      channel: 'WECHAT',
      outTradeNo,
      amountCents: 9900,
      description: '专业版 1 年',
      payer: { kind: 'openid', value: 'o-fake-1' },
    })
    return outTradeNo
  }

  function transactionIdOf(outTradeNo: string): string {
    const order = h.kit.provider.getOrder(outTradeNo)
    expect(order).toBeDefined()
    return order?.transactionId ?? ''
  }

  // 用例 ①
  it('Fake 下单 → simulate 回调 → 处理器 onPaid 被调一次', async () => {
    const outTradeNo = await placeOrder()

    // 下单时拼出来的 notifyUrl 必须正好是统一回调控制器的路由。
    expect(h.kit.provider.getOrder(outTradeNo)?.notifyUrl).toBe(
      'https://api.example.com/api/public/pay/wechat/notify',
    )

    const res = await h.kit.simulatePaid(outTradeNo)

    expect(res.status).toBe(200)
    // 微信读的是顶层字符串 code，被信封包成 {code:0,...} 就会被判失败并无限重推。
    expect(res.body).toEqual({ code: 'SUCCESS', message: '成功' })
    expect(h.handler.paid).toHaveLength(1)
    expect(h.handler.paid[0]).toMatchObject({
      kind: 'PAY_SUCCESS',
      channel: 'WECHAT',
      outTradeNo,
      amountCents: 9900,
    })
  })

  // 用例 ②
  it('同一个 transactionId 回调两次，处理器只跑一次，第二次照样回成功应答', async () => {
    const outTradeNo = await placeOrder()

    const first = await h.kit.simulatePaid(outTradeNo)
    const second = await h.kit.simulatePaid(outTradeNo)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual({ code: 'SUCCESS', message: '成功' })
    expect(h.handler.paid).toHaveLength(1)
  })

  // 用例 ③
  it('伪造签名的回调返回 400，处理器没被调，也没有幂等占位残留', async () => {
    const outTradeNo = await placeOrder()
    const transactionId = transactionIdOf(outTradeNo)

    const res = await h.kit.simulatePaid(outTradeNo, { secret: '攻击者猜的 secret' })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'FAIL' })
    expect(h.handler.paid).toHaveLength(0)
    // 验签之前一个字节都不许落库：幂等表/缓存里不能有这个 transactionId，
    // 否则攻击者可以用伪造报文把真实回调的幂等键提前占掉。
    await expect(h.idempotency.seen(PAY_CALLBACK_IDEMPOTENCY_SCOPE, transactionId)).resolves.toBe(
      false,
    )
    expect(h.db.rows('IdempotencyKey')).toHaveLength(0)
  })

  // 用例 ④
  it('处理器抛错 → 500 让渠道重推、幂等占位被释放、审计记 FAIL', async () => {
    const outTradeNo = await placeOrder()
    const transactionId = transactionIdOf(outTradeNo)
    h.handler.failNext = true

    const failed = await h.kit.simulatePaid(outTradeNo)

    expect(failed.status).toBe(500)
    expect(failed.body).toMatchObject({ code: 'FAIL' })
    expect(h.handler.paid).toHaveLength(0)

    // 占位必须放掉，否则这笔单在整个 TTL（24 小时）内都进不来，渠道白重推。
    await expect(h.idempotency.seen(PAY_CALLBACK_IDEMPOTENCY_SCOPE, transactionId)).resolves.toBe(
      false,
    )

    const fails = h.db.rows('PlatformAuditLog').filter((r) => r['result'] === 'FAIL')
    expect(fails).toHaveLength(1)
    expect(fails[0]).toMatchObject({ action: 'payment.callback', targetId: outTradeNo })

    // 渠道重推一次就该成功——这才叫「可重试」。
    const retried = await h.kit.simulatePaid(outTradeNo)
    expect(retried.status).toBe(200)
    expect(h.handler.paid).toHaveLength(1)
  })

  // 用例 ⑤
  it('未注册的 outTradeNo 前缀：打 error 并回成功应答，避免渠道无限重推', async () => {
    const outTradeNo = await placeOrder('NOONE')

    const res = await h.kit.simulatePaid(outTradeNo)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ code: 'SUCCESS', message: '成功' })
    expect(h.handler.paid).toHaveLength(0)

    const errors = h.logger.entries.filter(
      (e) => e.level === 'error' && e.message.includes('没有注册领域处理器'),
    )
    expect(errors).toHaveLength(1)
    // 钱已到账但没兑现，必须留痕，否则事后连补都不知道补哪笔。
    expect(h.db.rows('PlatformAuditLog').filter((r) => r['result'] === 'FAIL')).toHaveLength(1)
  })

  it('渠道参数大小写不敏感，未知渠道回 400', async () => {
    const outTradeNo = await placeOrder()
    const raw = h.kit.buildPaidCallback(outTradeNo)

    // notifyUrl 里我们写的是小写 `wechat`，渠道原样回传；大写 `WECHAT` 也要认。
    const upper = await request(h.app.getHttpServer())
      .post('/api/public/pay/WECHAT/notify')
      .set(raw.headers)
      .type('json')
      .send(raw.body)
    expect(upper.status).toBe(200)
    expect(h.handler.paid).toHaveLength(1)

    const unknown = await request(h.app.getHttpServer())
      .post('/api/public/pay/paypal/notify')
      .type('json')
      .send('{}')
    expect(unknown.status).toBe(400)
  })
})
