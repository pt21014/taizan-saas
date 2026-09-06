import { CallbackParseError, SignatureError, type RawCallback } from '@taizan/payment-core'
import * as crypto from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  decryptResource,
  parseWechatPayCallback,
  parseWechatPayRefundCallback,
  pickHeader,
} from './callback'
import { rsaSha256Sign } from './sign'
import type { WechatPayConfig } from './types'

const API_V3_KEY = 'QyeFGD5fS4NWO3zwSCingv56HAoXhFma' // 正好 32 字节
const PUB_KEY_ID = 'PUB_KEY_ID_0117'

let priv: string
let pub: string

beforeAll(() => {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString()
})

function cfg(overrides: Partial<WechatPayConfig> = {}): WechatPayConfig {
  return {
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
    ...overrides,
  } as WechatPayConfig
}

/**
 * 用与微信完全相同的算法自己造一份回调：AES-256-GCM 加密 resource，
 * 再用「微信的」私钥对 `时间戳\n随机串\n报文\n` 签名。
 *
 * 这样往返测的是真算法，而不是「我们自己解自己写的假数据」。
 */
function makeNotify(
  resource: Record<string, unknown>,
  opts: {
    eventType?: string
    apiV3Key?: string
    associatedData?: string
    signWith?: string
    serial?: string
    timestamp?: string
    nonce?: string
  } = {},
): RawCallback {
  const key = opts.apiV3Key ?? API_V3_KEY
  const iv = 'abcdefghijkl'
  const aad = opts.associatedData ?? 'transaction'
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(resource), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const body = JSON.stringify({
    id: 'evt-1',
    create_time: '2026-09-05T18:00:00+08:00',
    event_type: opts.eventType ?? 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext: enc.toString('base64'),
      associated_data: aad,
      nonce: iv,
    },
  })
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000).toString()
  const nonce = opts.nonce ?? 'NONCE123'
  const signature = rsaSha256Sign(`${timestamp}\n${nonce}\n${body}\n`, opts.signWith ?? priv)
  return {
    headers: {
      'Wechatpay-Timestamp': timestamp,
      'Wechatpay-Nonce': nonce,
      'Wechatpay-Signature': signature,
      'Wechatpay-Serial': opts.serial ?? PUB_KEY_ID,
    },
    body,
  }
}

const PAY_RESOURCE = {
  out_trade_no: 'PLAN-01JC0K3V7Q8ZP5R2M9YB4XN6TA',
  transaction_id: '4200002000202609051234567890',
  trade_state: 'SUCCESS',
  success_time: '2026-09-05T18:00:00+08:00',
  payer: { openid: 'o_user_123' },
  amount: { total: 9900, payer_total: 9800, currency: 'CNY' },
}

describe('pickHeader', () => {
  it('大小写不敏感——网关经常改头的大小写', () => {
    expect(pickHeader({ 'WECHATPAY-NONCE': 'n' }, 'Wechatpay-Nonce')).toBe('n')
    expect(pickHeader({ 'wechatpay-nonce': 'n' }, 'Wechatpay-Nonce')).toBe('n')
    expect(pickHeader({}, 'Wechatpay-Nonce')).toBe('')
  })
})

describe('decryptResource', () => {
  const plain = '{"out_trade_no":"PLAN-1","trade_state":"SUCCESS"}'
  const encrypt = (aad?: string, key = API_V3_KEY) => {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, 'abcdefghijkl')
    if (aad) cipher.setAAD(Buffer.from(aad))
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return Buffer.concat([enc, cipher.getAuthTag()]).toString('base64')
  }

  it('能解出原文', () => {
    expect(decryptResource(API_V3_KEY, { ciphertext: encrypt(), nonce: 'abcdefghijkl' })).toBe(
      plain,
    )
  })

  it('带 associated_data 时也能解', () => {
    expect(
      decryptResource(API_V3_KEY, {
        ciphertext: encrypt('transaction'),
        nonce: 'abcdefghijkl',
        associated_data: 'transaction',
      }),
    ).toBe(plain)
  })

  it('密钥不对时抛错，不会返回垃圾数据', () => {
    expect(() =>
      decryptResource('WRONGKEYWRONGKEYWRONGKEYWRONGKEY', {
        ciphertext: encrypt(),
        nonce: 'abcdefghijkl',
      }),
    ).toThrow()
  })

  it('密文被篡改时认证标签校验失败', () => {
    const tampered = Buffer.from(encrypt(), 'base64')
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    expect(() =>
      decryptResource(API_V3_KEY, {
        ciphertext: tampered.toString('base64'),
        nonce: 'abcdefghijkl',
      }),
    ).toThrow()
  })

  it('associated_data 对不上也解不出来', () => {
    expect(() =>
      decryptResource(API_V3_KEY, {
        ciphertext: encrypt('transaction'),
        nonce: 'abcdefghijkl',
        associated_data: 'refund',
      }),
    ).toThrow()
  })

  it('apiV3Key 长度不对时报的是「必须 32 字节」，不是 node 那句 Invalid key length', () => {
    expect(() => decryptResource('tooshort', { ciphertext: 'x', nonce: 'n' })).toThrow(/32 字节/)
  })
})

describe('parseWechatPayCallback：往返', () => {
  it('自己按同一算法造的回调能被完整解析成 CallbackEvent', () => {
    const event = parseWechatPayCallback(makeNotify(PAY_RESOURCE), cfg())
    expect(event.kind).toBe('PAY_SUCCESS')
    expect(event.channel).toBe('WECHAT')
    expect(event.outTradeNo).toBe('PLAN-01JC0K3V7Q8ZP5R2M9YB4XN6TA')
    expect(event.transactionId).toBe('4200002000202609051234567890')
    // 对账要用实付（payer_total），否则用了立减金的订单永远对不平
    expect(event.amountCents).toBe(9800)
    expect(event.paidAt.toISOString()).toBe(new Date('2026-09-05T18:00:00+08:00').toISOString())
    expect(event.payer).toEqual({ kind: 'openid', value: 'o_user_123' })
    expect(event.raw).toMatchObject({ trade_state: 'SUCCESS' })
  })

  it('没有 payer_total 时回落到 total', () => {
    const event = parseWechatPayCallback(
      makeNotify({ ...PAY_RESOURCE, amount: { total: 9900 } }),
      cfg(),
    )
    expect(event.amountCents).toBe(9900)
  })

  it('服务商回调的 payer.sub_openid 也认——只读 openid 的话服务商模式全查不到用户', () => {
    const event = parseWechatPayCallback(
      makeNotify({ ...PAY_RESOURCE, payer: { sub_openid: 'o_sub_1' } }),
      cfg(),
    )
    expect(event.payer).toEqual({ kind: 'openid', value: 'o_sub_1' })
  })

  it('trade_state 不是 SUCCESS 一律 PAY_FAIL，不留「等下一次回调」的幻想', () => {
    for (const state of ['CLOSED', 'PAYERROR', 'REVOKED', 'NOTPAY']) {
      expect(
        parseWechatPayCallback(makeNotify({ ...PAY_RESOURCE, trade_state: state }), cfg()).kind,
      ).toBe('PAY_FAIL')
    }
  })
})

describe('parseWechatPayCallback：伪造与篡改一律拒绝', () => {
  it('用别的私钥签 → SignatureError', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const raw = makeNotify(PAY_RESOURCE, {
      signWith: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    })
    expect(() => parseWechatPayCallback(raw, cfg())).toThrow(SignatureError)
  })

  it('报文被改过一个字节 → SignatureError（只解密不验签挡不住的就是这个）', () => {
    const raw = makeNotify(PAY_RESOURCE)
    const tampered = { headers: raw.headers, body: raw.body.replace('evt-1', 'evt-2') }
    expect(() => parseWechatPayCallback(tampered, cfg())).toThrow(SignatureError)
  })

  it('serial 与已配置的公钥ID/证书序列号都对不上 → SignatureError，且 message 说清是序列号问题', () => {
    const raw = makeNotify(PAY_RESOURCE, { serial: 'UNKNOWN_SERIAL' })
    expect(() => parseWechatPayCallback(raw, cfg())).toThrow(/序列号/)
  })

  it('缺任意一个 Wechatpay-* 头 → SignatureError，不是「先解密看看」', () => {
    const raw = makeNotify(PAY_RESOURCE)
    for (const drop of [
      'Wechatpay-Timestamp',
      'Wechatpay-Nonce',
      'Wechatpay-Signature',
      'Wechatpay-Serial',
    ]) {
      const headers = { ...raw.headers }
      delete headers[drop]
      expect(() => parseWechatPayCallback({ headers, body: raw.body }, cfg())).toThrow(
        SignatureError,
      )
    }
  })

  it('时间戳超窗按重放拒绝', () => {
    const raw = makeNotify(PAY_RESOURCE, { timestamp: '1000000000' })
    expect(() => parseWechatPayCallback(raw, cfg())).toThrow(/重放/)
  })

  it('skipTimestampCheck 只影响时间窗，不影响验签', () => {
    const raw = makeNotify(PAY_RESOURCE, { timestamp: '1000000000' })
    expect(parseWechatPayCallback(raw, cfg(), { skipTimestampCheck: true }).kind).toBe(
      'PAY_SUCCESS',
    )
  })

  it('验签过了但 apiV3Key 配错 → CallbackParseError（与验签失败要能分开）', () => {
    const raw = makeNotify(PAY_RESOURCE)
    const wrong = cfg()
    wrong.credentials.apiV3Key = 'B'.repeat(32)
    expect(() => parseWechatPayCallback(raw, wrong)).toThrow(CallbackParseError)
  })

  it('resource.algorithm 不是 AEAD_AES_256_GCM → CallbackParseError', () => {
    const raw = makeNotify(PAY_RESOURCE)
    const body = raw.body.replace('AEAD_AES_256_GCM', 'SOMETHING_ELSE')
    const signature = rsaSha256Sign(
      `${raw.headers['Wechatpay-Timestamp']}\n${raw.headers['Wechatpay-Nonce']}\n${body}\n`,
      priv,
    )
    expect(() =>
      parseWechatPayCallback(
        { headers: { ...raw.headers, 'Wechatpay-Signature': signature }, body },
        cfg(),
      ),
    ).toThrow(CallbackParseError)
  })

  it('解密后缺 out_trade_no → CallbackParseError', () => {
    const raw = makeNotify({ trade_state: 'SUCCESS' })
    expect(() => parseWechatPayCallback(raw, cfg())).toThrow(/out_trade_no/)
  })
})

describe('parseWechatPayRefundCallback', () => {
  const REFUND_RESOURCE = {
    out_trade_no: 'PLAN-1',
    out_refund_no: 'RF-1',
    refund_id: '50000000382019052709732678859',
    refund_status: 'SUCCESS',
    success_time: '2026-09-05T19:00:00+08:00',
    amount: { total: 9900, refund: 3000, payer_refund: 3000 },
  }

  it('归一化成 RefundEvent', () => {
    const event = parseWechatPayRefundCallback(
      makeNotify(REFUND_RESOURCE, { eventType: 'REFUND.SUCCESS', associatedData: 'refund' }),
      cfg(),
    )
    expect(event.kind).toBe('REFUND_SUCCESS')
    expect(event.outTradeNo).toBe('PLAN-1')
    expect(event.outRefundNo).toBe('RF-1')
    expect(event.refundCents).toBe(3000)
    expect(event.totalCents).toBe(9900)
    expect(event.successAt?.toISOString()).toBe(new Date('2026-09-05T19:00:00+08:00').toISOString())
  })

  it('CLOSED 与 ABNORMAL 分别映射到 REFUND_CLOSED / REFUND_FAIL', () => {
    const closed = parseWechatPayRefundCallback(
      makeNotify(
        { ...REFUND_RESOURCE, refund_status: 'CLOSED', success_time: undefined },
        { associatedData: 'refund' },
      ),
      cfg(),
    )
    expect(closed.kind).toBe('REFUND_CLOSED')
    expect(closed.successAt).toBeNull()

    const abnormal = parseWechatPayRefundCallback(
      makeNotify({ ...REFUND_RESOURCE, refund_status: 'ABNORMAL' }, { associatedData: 'refund' }),
      cfg(),
    )
    // ABNORMAL 卡在微信侧需要人工处理，归到 FAIL 让上层报警而不是静默重试
    expect(abnormal.kind).toBe('REFUND_FAIL')
  })

  it('缺 out_refund_no → CallbackParseError（退款回调的幂等键就是它）', () => {
    expect(() =>
      parseWechatPayRefundCallback(makeNotify({ refund_status: 'SUCCESS' }), cfg()),
    ).toThrow(/out_refund_no/)
  })

  it('伪造的退款回调同样被拒', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const raw = makeNotify(REFUND_RESOURCE, {
      signWith: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    })
    expect(() => parseWechatPayRefundCallback(raw, cfg())).toThrow(SignatureError)
  })
})

describe('平台证书模式', () => {
  it('serial 是平台证书序列号时，用平台证书验签也能通过', () => {
    const c = cfg()
    delete c.credentials.publicKeyId
    delete c.credentials.publicKeyPem
    c.credentials.platformSerialNo = 'CERT_SERIAL'
    c.credentials.platformCertPem = pub // 本函数同时接受证书与裸公钥 PEM
    const raw = makeNotify(PAY_RESOURCE, { serial: 'CERT_SERIAL' })
    expect(parseWechatPayCallback(raw, c).kind).toBe('PAY_SUCCESS')
  })

  it('两套都没配 → 所有回调都被拒（这是刻意的，不是 bug）', () => {
    const c = cfg()
    delete c.credentials.publicKeyId
    delete c.credentials.publicKeyPem
    expect(() => parseWechatPayCallback(makeNotify(PAY_RESOURCE), c)).toThrow(SignatureError)
  })
})
