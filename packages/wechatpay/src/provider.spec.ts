import { PAYMENT_ERROR, type ProviderConfig } from '@taizan/payment-core'
import * as crypto from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { FakeWechatPayClient } from './fake-client'
import {
  buildTransactionBody,
  closeOrderBody,
  mapTradeState,
  normalizeTransaction,
  queryOrderPath,
  queryRefundPath,
  transactionPath,
  type PlaceOrderInput,
} from './platform-pay'
import { WechatPayProvider } from './provider'
import { rsaSha256Verify } from './sign'
import { narrowWechatPayConfig, payAppId, type WechatPayConfig } from './types'

let priv: string
let pub: string

beforeAll(() => {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString()
})

const credRaw = () => ({
  mchId: '1900009191',
  serialNo: 'MCH_SERIAL',
  privateKeyPem: priv,
  apiV3Key: 'A'.repeat(32),
})

const directCfg = (): ProviderConfig => ({
  mode: 'DIRECT',
  appId: 'wx_direct_app',
  credentials: credRaw(),
})

const partnerCfg = (subAppId?: string): ProviderConfig => ({
  mode: 'PARTNER',
  spAppId: 'wx_sp_app',
  subMchId: '1666666666',
  ...(subAppId ? { subAppId } : {}),
  credentials: credRaw(),
})

describe('narrowWechatPayConfig', () => {
  it('DIRECT 与 PARTNER 都能 narrow', () => {
    expect(narrowWechatPayConfig(directCfg()).mode).toBe('DIRECT')
    expect(narrowWechatPayConfig(partnerCfg()).mode).toBe('PARTNER')
  })

  it('mode 省略时按 DIRECT', () => {
    const cfg = directCfg()
    delete cfg['mode']
    expect(narrowWechatPayConfig(cfg).mode).toBe('DIRECT')
  })

  it('缺字段时报错指到具体字段，而不是几百毫秒后微信回一句 PARAM_ERROR', () => {
    const cfg = directCfg()
    delete (cfg['credentials'] as Record<string, unknown>)['privateKeyPem']
    expect(() => narrowWechatPayConfig(cfg)).toThrow(/credentials\.privateKeyPem/)

    const noApp = directCfg()
    delete noApp['appId']
    expect(() => narrowWechatPayConfig(noApp)).toThrow(/config\.appId/)

    expect(() => narrowWechatPayConfig({})).toThrow(/credentials/)
  })

  it('mode 不认识时抛 CONFIG_INVALID', () => {
    try {
      narrowWechatPayConfig({ ...directCfg(), mode: 'ALIPAY' })
      expect.unreachable('应该抛错')
    } catch (e) {
      expect((e as { code: number }).code).toBe(PAYMENT_ERROR.CONFIG_INVALID.code)
    }
  })

  it('payAppId：服务商模式优先 sub_appid（openid 归属它）', () => {
    expect(payAppId(narrowWechatPayConfig(directCfg()))).toBe('wx_direct_app')
    expect(payAppId(narrowWechatPayConfig(partnerCfg()))).toBe('wx_sp_app')
    expect(payAppId(narrowWechatPayConfig(partnerCfg('wx_sub_app')))).toBe('wx_sub_app')
  })
})

describe('下单报文：直连 vs 服务商', () => {
  const input: PlaceOrderInput = {
    outTradeNo: 'PLAN-1',
    amountCents: 9900,
    description: '专业版 1 年',
    notifyUrl: 'https://example.com/notify',
    openId: 'o_user_1',
  }

  it('直连模式：appid + mchid + payer.openid', () => {
    const cfg = narrowWechatPayConfig(directCfg())
    expect(buildTransactionBody(cfg, input, 'JSAPI')).toMatchObject({
      appid: 'wx_direct_app',
      mchid: '1900009191',
      out_trade_no: 'PLAN-1',
      amount: { total: 9900, currency: 'CNY' },
      payer: { openid: 'o_user_1' },
    })
    expect(transactionPath(cfg, 'JSAPI')).toBe('/v3/pay/transactions/jsapi')
  })

  it('服务商模式：sp_* + sub_mchid，且签名商户号是服务商的', () => {
    const cfg = narrowWechatPayConfig(partnerCfg())
    const body = buildTransactionBody(cfg, input, 'JSAPI')
    expect(body).toMatchObject({
      sp_appid: 'wx_sp_app',
      sp_mchid: '1900009191',
      sub_mchid: '1666666666',
      payer: { sp_openid: 'o_user_1' },
    })
    expect(body).not.toHaveProperty('sub_appid')
    expect(transactionPath(cfg, 'JSAPI')).toBe('/v3/pay/partner/transactions/jsapi')
  })

  it('配了 sub_appid 就必须用 sub_openid——用 sp_openid 微信直接拒单', () => {
    const cfg = narrowWechatPayConfig(partnerCfg('wx_sub_app'))
    const body = buildTransactionBody(cfg, input, 'JSAPI')
    expect(body['sub_appid']).toBe('wx_sub_app')
    expect(body['payer']).toEqual({ sub_openid: 'o_user_1' })
  })

  it('分账标记只在显式要求时才打——没开通分账时打了，钱会被冻到分账超时', () => {
    const cfg = narrowWechatPayConfig(directCfg())
    expect(buildTransactionBody(cfg, input, 'JSAPI')).not.toHaveProperty('settle_info')
    expect(
      buildTransactionBody(cfg, { ...input, profitSharing: true }, 'JSAPI')['settle_info'],
    ).toEqual({ profit_sharing: true })
  })

  it('description 超过 127 字符时截断，不是报错', () => {
    const cfg = narrowWechatPayConfig(directCfg())
    const body = buildTransactionBody(cfg, { ...input, description: 'x'.repeat(200) }, 'JSAPI')
    expect(String(body['description'])).toHaveLength(127)
  })

  it('JSAPI 缺 openId、H5 缺 payerClientIp 都在调微信之前拦住', () => {
    const cfg = narrowWechatPayConfig(directCfg())
    const { openId: _drop, ...noOpenId } = input
    expect(() => buildTransactionBody(cfg, noOpenId, 'JSAPI')).toThrow(/openId/)
    expect(() => buildTransactionBody(cfg, noOpenId, 'H5')).toThrow(/payerClientIp/)
  })

  it('H5 带 scene_info.payer_client_ip', () => {
    const cfg = narrowWechatPayConfig(directCfg())
    expect(
      buildTransactionBody(cfg, { ...input, payerClientIp: '1.2.3.4' }, 'H5')['scene_info'],
    ).toEqual({ payer_client_ip: '1.2.3.4', h5_info: { type: 'Wap' } })
  })

  it('NATIVE 不带 payer', () => {
    const cfg = narrowWechatPayConfig(directCfg())
    expect(buildTransactionBody(cfg, input, 'NATIVE')).not.toHaveProperty('payer')
  })
})

describe('查单/关单/退款路径', () => {
  it('直连带 mchid，服务商带 sp_mchid + sub_mchid', () => {
    expect(queryOrderPath(narrowWechatPayConfig(directCfg()), 'PLAN-1')).toBe(
      '/v3/pay/transactions/out-trade-no/PLAN-1?mchid=1900009191',
    )
    expect(queryOrderPath(narrowWechatPayConfig(partnerCfg()), 'PLAN-1')).toBe(
      '/v3/pay/partner/transactions/out-trade-no/PLAN-1?sp_mchid=1900009191&sub_mchid=1666666666',
    )
  })

  it('关单报文两种模式不同', () => {
    expect(closeOrderBody(narrowWechatPayConfig(directCfg()))).toEqual({ mchid: '1900009191' })
    expect(closeOrderBody(narrowWechatPayConfig(partnerCfg()))).toEqual({
      sp_mchid: '1900009191',
      sub_mchid: '1666666666',
    })
  })

  it('退款查询：服务商只带 sub_mchid（带 sp_mchid 会被判为多余参数）', () => {
    expect(queryRefundPath(narrowWechatPayConfig(partnerCfg()), 'RF-1')).toBe(
      '/v3/refund/domestic/refunds/RF-1?sub_mchid=1666666666',
    )
    expect(queryRefundPath(narrowWechatPayConfig(directCfg()), 'RF-1')).toBe(
      '/v3/refund/domestic/refunds/RF-1',
    )
  })
})

describe('mapTradeState / normalizeTransaction', () => {
  it('USERPAYING 单独归到 PAYING，不能混进 NOTPAY', () => {
    expect(mapTradeState('USERPAYING')).toBe('PAYING')
    expect(mapTradeState('SUCCESS')).toBe('SUCCESS')
    expect(mapTradeState('CLOSED')).toBe('CLOSED')
    expect(mapTradeState('REVOKED')).toBe('REVOKED')
    expect(mapTradeState('REFUND')).toBe('REFUND')
    expect(mapTradeState('PAYERROR')).toBe('FAIL')
    expect(mapTradeState('NOTPAY')).toBe('NOTPAY')
    expect(mapTradeState('什么鬼')).toBe('NOTPAY')
  })

  it('归一化认 openid 与 sub_openid，金额优先实付', () => {
    expect(
      normalizeTransaction({
        trade_state: 'SUCCESS',
        transaction_id: 'T1',
        payer: { sub_openid: 'o_1' },
        amount: { total: 100, payer_total: 90 },
      }),
    ).toMatchObject({
      state: 'SUCCESS',
      transactionId: 'T1',
      amountCents: 90,
      payer: { kind: 'openid', value: 'o_1' },
    })
  })
})

describe('WechatPayProvider', () => {
  let api: FakeWechatPayClient
  let provider: WechatPayProvider

  beforeEach(() => {
    api = new FakeWechatPayClient()
    provider = new WechatPayProvider({ api })
  })

  it('channel 是 WECHAT', () => {
    expect(provider.channel).toBe('WECHAT')
  })

  it('payer 有 openid 时默认走 JSAPI，返回的是可验证的二次签名整包', async () => {
    const res = await provider.createOrder(
      {
        outTradeNo: 'PLAN-1',
        amountCents: 9900,
        description: '专业版',
        payer: { kind: 'openid', value: 'o_user_1' },
        notifyUrl: 'https://example.com/notify',
      },
      directCfg(),
    )
    const p = res.payParams as Record<string, string>
    expect(p['signType']).toBe('RSA')
    expect(p['appId']).toBe('wx_direct_app')
    expect(p['package']).toBe(`prepay_id=${res.prepayRef}`)
    expect(
      rsaSha256Verify(
        `${p['appId']}\n${p['timeStamp']}\n${p['nonceStr']}\n${p['package']}\n`,
        p['paySign'] ?? '',
        pub,
      ),
    ).toBe(true)
  })

  it('payer.kind = none 时默认走 NATIVE，返回 codeUrl', async () => {
    const res = await provider.createOrder(
      {
        outTradeNo: 'PLAN-2',
        amountCents: 100,
        description: 'x',
        payer: { kind: 'none' },
        notifyUrl: 'https://example.com/notify',
      },
      directCfg(),
    )
    expect(res.payParams['codeUrl']).toMatch(/^weixin:\/\/wxpay/)
  })

  it('extra.tradeType 显式指定 H5，并把 payerClientIp 传下去', async () => {
    const res = await provider.createOrder(
      {
        outTradeNo: 'PLAN-3',
        amountCents: 100,
        description: 'x',
        payer: { kind: 'none' },
        notifyUrl: 'https://example.com/notify',
        extra: { tradeType: 'H5', payerClientIp: '1.2.3.4', attach: 'a1' },
      },
      directCfg(),
    )
    expect(String(res.payParams['h5Url'])).toContain('checkmweb')
    const call = api.lastCall('h5')?.payload as PlaceOrderInput
    expect(call.payerClientIp).toBe('1.2.3.4')
    expect(call.attach).toBe('a1')
  })

  it('查无此单时 queryOrder 返回 NOTPAY 而不是抛', async () => {
    api.queryResult = null
    expect(await provider.queryOrder('PLAN-X', directCfg())).toEqual({ state: 'NOTPAY' })
  })

  it('查到时把摘要透传出去', async () => {
    api.queryResult = {
      state: 'SUCCESS',
      transactionId: 'T1',
      amountCents: 9900,
      payer: { kind: 'openid', value: 'o_1' },
      raw: {},
    }
    expect(await provider.queryOrder('PLAN-1', directCfg())).toMatchObject({
      state: 'SUCCESS',
      transactionId: 'T1',
      amountCents: 9900,
    })
  })

  it('退款金额不合法时在调微信之前就拦住', async () => {
    const bad = { outTradeNo: 'PLAN-1', outRefundNo: 'RF-1', totalCents: 100, refundCents: 200 }
    await expect(provider.refund(bad, directCfg())).rejects.toThrow(/退款金额/)
    await expect(provider.refund({ ...bad, refundCents: 0 }, directCfg())).rejects.toThrow()
    expect(api.lastCall('refund')).toBeUndefined()
  })

  it('合法退款透传给 api', async () => {
    const res = await provider.refund(
      { outTradeNo: 'PLAN-1', outRefundNo: 'RF-1', totalCents: 100, refundCents: 100 },
      directCfg(),
    )
    expect(res.status).toBe('SUCCESS')
    expect(res.refundCents).toBe(100)
  })

  it('配置不合法时 createOrder 直接抛 CONFIG_INVALID，不发请求', async () => {
    await expect(
      provider.createOrder(
        {
          outTradeNo: 'PLAN-1',
          amountCents: 1,
          description: 'x',
          payer: { kind: 'none' },
          notifyUrl: 'https://example.com/n',
        },
        {},
      ),
    ).rejects.toThrow(/credentials/)
    expect(api.calls).toHaveLength(0)
  })
})

describe('FakeWechatPayClient', () => {
  it('记录每一次调用，便于断言报文', async () => {
    const api = new FakeWechatPayClient()
    const cfg = narrowWechatPayConfig(directCfg()) as WechatPayConfig
    await api.native(cfg, {
      outTradeNo: 'PLAN-1',
      amountCents: 1,
      description: 'x',
      notifyUrl: 'https://e/n',
    })
    expect(api.calls).toHaveLength(1)
    expect(api.lastCall('native')?.payload).toMatchObject({ outTradeNo: 'PLAN-1' })
    api.reset()
    expect(api.calls).toHaveLength(0)
  })

  it('JSAPI 缺 openId 时与真实 client 一样报错', async () => {
    const api = new FakeWechatPayClient()
    const cfg = narrowWechatPayConfig(directCfg()) as WechatPayConfig
    await expect(
      api.jsapi(cfg, {
        outTradeNo: 'PLAN-1',
        amountCents: 1,
        description: 'x',
        notifyUrl: 'https://e/n',
      }),
    ).rejects.toThrow(/openId/)
  })
})
