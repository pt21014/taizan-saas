import { describe, expect, it } from 'vitest'

import { PAYMENT_ERROR, SignatureError } from './errors'
import { FAKE_SIGNATURE_HEADER, FakeProvider } from './fake-provider'
import { PLAN_ORDER_PREFIX, buildOutTradeNo } from './out-trade-no'
import type { ProviderConfig } from './provider'

const cfg: ProviderConfig = {}

async function placeOrder(provider: FakeProvider, amountCents = 9900) {
  const outTradeNo = buildOutTradeNo(PLAN_ORDER_PREFIX)
  const res = await provider.createOrder(
    {
      outTradeNo,
      amountCents,
      description: '专业版 1 年',
      payer: { kind: 'openid', value: 'o_fake_123' },
      notifyUrl: 'https://example.com/api/public/pay/WECHAT/notify',
    },
    cfg,
  )
  return { outTradeNo, res }
}

describe('FakeProvider 下单', () => {
  it('返回可下发前端的 payParams 与 prepayRef，并把订单记在内存里', async () => {
    const provider = new FakeProvider()
    const { outTradeNo, res } = await placeOrder(provider)
    expect(res.payParams['provider']).toBe('FAKE')
    expect(res.prepayRef).toBe(`FAKEPREPAY-${outTradeNo}`)
    expect(provider.getOrder(outTradeNo)?.state).toBe('NOTPAY')
    expect(provider.listOrders()).toHaveLength(1)
  })

  it('默认冒充 WECHAT，也可以冒充别的渠道', async () => {
    expect(new FakeProvider().channel).toBe('WECHAT')
    expect(new FakeProvider({ channel: 'ALIPAY' }).channel).toBe('ALIPAY')
  })

  it('同一个 outTradeNo 重复下单是错误，不是幂等成功', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider)
    await expect(
      provider.createOrder(
        {
          outTradeNo,
          amountCents: 1,
          description: 'x',
          payer: { kind: 'none' },
          notifyUrl: 'https://example.com/n',
        },
        cfg,
      ),
    ).rejects.toThrow(/已经下过单/)
  })
})

describe('FakeProvider 支付回调往返', () => {
  it('下单 → simulateCallback → parseCallback 拿到归一化事件', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider, 12345)
    const paidAt = new Date('2026-09-05T10:00:00.000Z')

    const raw = provider.simulateCallback(outTradeNo, { paidAt })
    const event = await provider.parseCallback(raw, cfg)

    expect(event.kind).toBe('PAY_SUCCESS')
    expect(event.channel).toBe('WECHAT')
    expect(event.outTradeNo).toBe(outTradeNo)
    expect(event.transactionId).toBe(provider.getOrder(outTradeNo)?.transactionId)
    expect(event.amountCents).toBe(12345)
    expect(event.paidAt.toISOString()).toBe(paidAt.toISOString())
    expect(event.payer).toEqual({ kind: 'openid', value: 'o_fake_123' })
  })

  it('回调之后查单变成 SUCCESS——e2e 里的兜底对账也能跑', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider)
    expect((await provider.queryOrder(outTradeNo, cfg)).state).toBe('NOTPAY')
    await provider.parseCallback(provider.simulateCallback(outTradeNo), cfg)
    expect((await provider.queryOrder(outTradeNo, cfg)).state).toBe('SUCCESS')
  })

  it('查无此单按「没付过」处理，与微信 NOTFOUND 的语义一致', async () => {
    const provider = new FakeProvider()
    expect(await provider.queryOrder('PLAN-NOPE', cfg)).toEqual({ state: 'NOTPAY' })
  })

  it('PAY_FAIL 也能模拟', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider)
    const event = await provider.parseCallback(
      provider.simulateCallback(outTradeNo, { kind: 'PAY_FAIL' }),
      cfg,
    )
    expect(event.kind).toBe('PAY_FAIL')
  })

  it('没下过单就模拟回调会抛 ORDER_NOT_FOUND', () => {
    const provider = new FakeProvider()
    try {
      provider.simulateCallback('PLAN-NOPE')
      expect.unreachable('应该抛错')
    } catch (e) {
      expect((e as { code: number }).code).toBe(PAYMENT_ERROR.ORDER_NOT_FOUND.code)
    }
  })
})

describe('FakeProvider 伪造回调必须被拒', () => {
  it('改一个字节就验签失败', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider)
    const raw = provider.simulateCallback(outTradeNo)
    const tampered = { ...raw, body: raw.body.replace('"amountCents":9900', '"amountCents":1') }
    await expect(provider.parseCallback(tampered, cfg)).rejects.toBeInstanceOf(SignatureError)
  })

  it('用别的 secret 签的回调被拒', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider)
    const raw = provider.simulateCallback(outTradeNo, { secret: 'attacker' })
    await expect(provider.parseCallback(raw, cfg)).rejects.toBeInstanceOf(SignatureError)
  })

  it('完全没有签名头也被拒，而不是「没签名就放行」', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider)
    const raw = provider.simulateCallback(outTradeNo)
    await expect(
      provider.parseCallback({ headers: {}, body: raw.body }, cfg),
    ).rejects.toBeInstanceOf(SignatureError)
  })

  it('签名头大小写不敏感——上层网关经常改头的大小写', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider)
    const raw = provider.simulateCallback(outTradeNo)
    const upper = {
      headers: { 'X-Taizan-Fake-Signature': raw.headers[FAKE_SIGNATURE_HEADER] as string },
      body: raw.body,
    }
    await expect(provider.parseCallback(upper, cfg)).resolves.toMatchObject({ outTradeNo })
  })

  it('cfg.fakeSecret 覆盖默认 secret：配错了就验不过', async () => {
    const provider = new FakeProvider({ secret: 'tenant-a' })
    const { outTradeNo } = await placeOrder(provider)
    const raw = provider.simulateCallback(outTradeNo)
    await expect(provider.parseCallback(raw, { fakeSecret: 'tenant-b' })).rejects.toBeInstanceOf(
      SignatureError,
    )
    await expect(provider.parseCallback(raw, { fakeSecret: 'tenant-a' })).resolves.toBeTruthy()
  })
})

describe('FakeProvider 退款', () => {
  it('退款 → simulateRefundCallback → parseRefundCallback 往返', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider, 10_000)
    await provider.parseCallback(provider.simulateCallback(outTradeNo), cfg)

    const res = await provider.refund(
      { outTradeNo, outRefundNo: 'RF-1', totalCents: 10_000, refundCents: 3000 },
      cfg,
    )
    expect(res.status).toBe('SUCCESS')
    expect(res.refundCents).toBe(3000)

    const event = await provider.parseRefundCallback(provider.simulateRefundCallback('RF-1'), cfg)
    expect(event.kind).toBe('REFUND_SUCCESS')
    expect(event.outTradeNo).toBe(outTradeNo)
    expect(event.outRefundNo).toBe('RF-1')
    expect(event.refundId).toBe(res.refundId)
    expect(event.refundCents).toBe(3000)
    expect(event.totalCents).toBe(10_000)
    expect(event.successAt).toBeInstanceOf(Date)
  })

  it('同一个退款单号重复申请是幂等的——否则超时重试会退两次钱', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider, 10_000)
    const req = { outTradeNo, outRefundNo: 'RF-1', totalCents: 10_000, refundCents: 3000 }
    const a = await provider.refund(req, cfg)
    const b = await provider.refund(req, cfg)
    expect(b.refundId).toBe(a.refundId)
  })

  it('退款失败事件的 successAt 是 null', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider, 10_000)
    await provider.refund(
      { outTradeNo, outRefundNo: 'RF-2', totalCents: 10_000, refundCents: 1 },
      cfg,
    )
    const event = await provider.parseRefundCallback(
      provider.simulateRefundCallback('RF-2', { kind: 'REFUND_FAIL' }),
      cfg,
    )
    expect(event.kind).toBe('REFUND_FAIL')
    expect(event.successAt).toBeNull()
  })

  it('原单不存在时退款抛 ORDER_NOT_FOUND', async () => {
    const provider = new FakeProvider()
    await expect(
      provider.refund(
        { outTradeNo: 'PLAN-NOPE', outRefundNo: 'RF-X', totalCents: 1, refundCents: 1 },
        cfg,
      ),
    ).rejects.toThrow(/原支付单不存在/)
  })
})

describe('FakeProvider.reset', () => {
  it('清空内存状态，让用例之间互不影响', async () => {
    const provider = new FakeProvider()
    const { outTradeNo } = await placeOrder(provider)
    provider.reset()
    expect(provider.getOrder(outTradeNo)).toBeUndefined()
    expect(provider.listOrders()).toEqual([])
  })
})
