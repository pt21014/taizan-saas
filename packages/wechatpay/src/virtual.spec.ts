import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  VIRTUAL_CLIENT_URI,
  VIRTUAL_MODE_GOODS,
  buildPaySig,
  buildSignData,
  buildSignature,
  buildXpayParams,
  checkXpayReady,
  pickXpayAppKey,
  resolveXpayEnv,
  shouldUseXpay,
  signXpayServerRequest,
} from './virtual'

/**
 * ## 官方测试向量（虚拟支付文档 §2.6）
 *
 * `uri=/xpay/query_user_balance`、`body={"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}`、
 * `appkey=12345` → `pay_sig=c37809f2...`；`session_key=9hAb/NEYUlkaMBEsmFgzig==` → `signature=089d9e8d...`
 *
 * **这两条先跑绿，再去怀疑别的。** 签名错（-15005/-15006）时微信不会告诉你错在哪一步，
 * 有这两条向量就能一次性排除「算法实现错了」这一大类。
 */
describe('官方测试向量自检', () => {
  const OFFICIAL_BODY = '{"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}'

  it('paySig 向量：hmac_sha256(appKey, uri + "&" + body)', () => {
    expect(buildPaySig('12345', OFFICIAL_BODY, '/xpay/query_user_balance')).toBe(
      'c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5',
    )
  })

  it('signature 向量：hmac_sha256(session_key, body)', () => {
    expect(buildSignature('9hAb/NEYUlkaMBEsmFgzig==', OFFICIAL_BODY)).toBe(
      '089d9e8dc5d308977360c4b79ec600a93d736802802a807d634192328032f6c7',
    )
  })

  it('signXpayServerRequest 一次给出两把签名，与向量一致', () => {
    const res = signXpayServerRequest({
      uri: '/xpay/query_user_balance',
      body: OFFICIAL_BODY,
      appKey: '12345',
      sessionKey: '9hAb/NEYUlkaMBEsmFgzig==',
    })
    expect(res.paySig).toBe('c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5')
    expect(res.signature).toBe('089d9e8dc5d308977360c4b79ec600a93d736802802a807d634192328032f6c7')
  })

  it('不需要用户态的接口不带 signature', () => {
    expect(
      signXpayServerRequest({ uri: '/xpay/query_order', body: '{}', appKey: 'k' }).signature,
    ).toBeUndefined()
  })
})

const base = {
  offerId: 'OF123',
  outTradeNo: 'PLAN20260905001',
  productId: 'prod_abc',
  goodsPriceCents: 9900,
  env: 0 as const,
}

describe('buildSignData', () => {
  it('返回的是字符串，不是对象——解析回对象再序列化就会对不上', () => {
    const s = buildSignData(base)
    expect(typeof s).toBe('string')
    expect(JSON.parse(s)).toMatchObject({
      offerId: 'OF123',
      buyQuantity: 1,
      env: 0,
      currencyType: 'CNY',
      productId: 'prod_abc',
      goodsPrice: 9900,
      outTradeNo: 'PLAN20260905001',
    })
  })

  it('同样的入参必须签出同样的字符串（键序稳定）', () => {
    expect(buildSignData(base)).toBe(buildSignData({ ...base }))
  })

  it('只放文档列出的字段，不多加 platform 这类自造字段', () => {
    const keys = Object.keys(JSON.parse(buildSignData(base)) as Record<string, unknown>)
    expect(new Set(keys)).toEqual(
      new Set([
        'offerId',
        'buyQuantity',
        'env',
        'currencyType',
        'productId',
        'goodsPrice',
        'outTradeNo',
      ]),
    )
  })

  it('attach 有才带上', () => {
    expect(JSON.parse(buildSignData(base))).not.toHaveProperty('attach')
    expect((JSON.parse(buildSignData({ ...base, attach: 'x' })) as { attach: string }).attach).toBe(
      'x',
    )
  })

  it('金额必须是正整数分——0 元订单不该走到这里', () => {
    expect(() => buildSignData({ ...base, goodsPriceCents: 0 })).toThrow()
    expect(() => buildSignData({ ...base, goodsPriceCents: 99.5 })).toThrow()
    expect(() => buildSignData({ ...base, goodsPriceCents: -1 })).toThrow()
  })

  it('没配 offerId 时报「还没开通」，不是签出一个必然失败的单', () => {
    expect(() => buildSignData({ ...base, offerId: '' })).toThrow(/offerId/)
  })

  it('env 只认 0 和 1', () => {
    expect(() => buildSignData({ ...base, env: 2 as never })).toThrow()
  })
})

describe('双 HMAC 签名', () => {
  const signData = buildSignData(base)

  it('paySig 拼的是 uri + "&" + signData，漏掉那个 & 是最容易犯的错', () => {
    expect(buildPaySig('APPKEY', signData)).toBe(
      createHmac('sha256', 'APPKEY')
        .update(`${VIRTUAL_CLIENT_URI}&${signData}`, 'utf8')
        .digest('hex'),
    )
    expect(buildPaySig('APPKEY', signData)).not.toBe(
      createHmac('sha256', 'APPKEY')
        .update(VIRTUAL_CLIENT_URI + signData, 'utf8')
        .digest('hex'),
    )
  })

  it('signature 是对 signData 本身签，不带 uri 前缀', () => {
    expect(buildSignature('SESSKEY', signData)).toBe(
      createHmac('sha256', 'SESSKEY').update(signData, 'utf8').digest('hex'),
    )
  })

  it('两个签名用的是不同的密钥，绝不能互换', () => {
    expect(buildPaySig('K', signData)).not.toBe(buildSignature('K', signData))
  })

  it('缺 session_key 时报的是「请重新登录」——它随每次 wx.login 变化，这是真实的恢复动作', () => {
    expect(() => buildSignature('', signData)).toThrow(/重新登录/)
  })
})

describe('buildXpayParams', () => {
  it('两个签名对的是同一个 signData 字符串', () => {
    const p = buildXpayParams({ ...base, appKey: 'A', sessionKey: 'S' })
    expect(p.paySig).toBe(buildPaySig('A', p.signData))
    expect(p.signature).toBe(buildSignature('S', p.signData))
    expect(p.mode).toBe(VIRTUAL_MODE_GOODS)
    expect(p.paySig).toHaveLength(64)
  })
})

describe('pickXpayAppKey', () => {
  it('现网用现网 AppKey，沙箱用沙箱 AppKey——两把不能混', () => {
    expect(pickXpayAppKey({ env: 0, appKey: 'P', sandboxAppKey: 'S' })).toBe('P')
    expect(pickXpayAppKey({ env: 1, appKey: 'P', sandboxAppKey: 'S' })).toBe('S')
  })

  it('沙箱没配 key 时抛错，不回落到现网那把——回落签出的单必然 -15006', () => {
    expect(() => pickXpayAppKey({ env: 1, appKey: 'P', sandboxAppKey: null })).toThrow(
      /沙箱 AppKey/,
    )
  })

  it('现网不看沙箱 key', () => {
    expect(() => pickXpayAppKey({ env: 0, appKey: '', sandboxAppKey: 'S' })).toThrow(/appKey/)
  })
})

describe('resolveXpayEnv', () => {
  it('只有显式的 "1" 才是沙箱，其余一律正式', () => {
    expect(resolveXpayEnv('1')).toBe(1)
    expect(resolveXpayEnv('0')).toBe(0)
    expect(resolveXpayEnv(undefined)).toBe(0)
    expect(resolveXpayEnv('true')).toBe(0)
    expect(resolveXpayEnv(' 1 ')).toBe(1)
  })
})

describe('checkXpayReady', () => {
  it('齐了才算就绪', () => {
    expect(checkXpayReady({ enabled: true, offerId: 'o', appKey: 'k' })).toEqual({ ready: true })
  })

  it('每一条缺失都要说清缺的是哪一条，不能笼统回「暂不支持」', () => {
    expect(checkXpayReady({ enabled: false, offerId: 'o', appKey: 'k' }).reason).toContain('启用')
    expect(checkXpayReady({ enabled: true, offerId: '', appKey: 'k' }).reason).toContain('offerId')
    expect(checkXpayReady({ enabled: true, offerId: 'o', appKey: '' }).reason).toContain('appKey')
  })
})

describe('shouldUseXpay', () => {
  const on = { isMiniProgram: true, ready: true, amountCents: 100 }

  it('小程序里全终端都走——不分 iOS 与安卓', () => {
    expect(shouldUseXpay(on)).toBe(true)
  })

  it('没有「安卓例外」这个口子：做成选项等于暗示「不开也行」，而代价是小程序被封', () => {
    // 这条盯的是签名本身。哪天有人想加回 androidToo / isIOS 这类参数，这里会红——
    // 那正是要它红的时候。
    expect(Object.keys(on)).toEqual(['isMiniProgram', 'ready', 'amountCents'])
  })

  it('没开通就不走：否则开关打开那一刻，还没配好的店连安卓都买不了', () => {
    expect(shouldUseXpay({ ...on, ready: false })).toBe(false)
  })

  it('H5 与公众号一律不走：虚拟支付只有小程序有', () => {
    expect(shouldUseXpay({ ...on, isMiniProgram: false })).toBe(false)
  })

  it('0 元订单不走支付', () => {
    expect(shouldUseXpay({ ...on, amountCents: 0 })).toBe(false)
  })
})
