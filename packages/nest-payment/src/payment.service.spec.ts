import 'reflect-metadata'
import { BizException } from '@taizan/nest-core'
import { FakeProvider, PAYMENT_ERROR } from '@taizan/payment-core'
import { beforeEach, describe, expect, it } from 'vitest'

import { normalizePaymentOptions } from './payment.options'
import { PaymentService } from './payment.service'
import { ProviderRegistry, StaticProviderConfigResolver } from './provider.registry'

const BASE = 'https://api.example.com'

function makeService(provider: FakeProvider): PaymentService {
  return new PaymentService(
    new ProviderRegistry([provider]),
    new StaticProviderConfigResolver(),
    normalizePaymentOptions(),
    BASE,
  )
}

describe('PaymentService', () => {
  let provider: FakeProvider
  let service: PaymentService

  beforeEach(() => {
    provider = new FakeProvider()
    service = makeService(provider)
  })

  describe('notifyUrl', () => {
    it('平台自身收款：不带租户参数', () => {
      expect(service.notifyUrlFor('WECHAT')).toBe(`${BASE}/api/public/pay/wechat/notify`)
      expect(service.refundNotifyUrlFor('WECHAT')).toBe(
        `${BASE}/api/public/pay/wechat/refund-notify`,
      )
    })

    it('商家自收款：带 ?tenant=，因为验签发生在解开报文之前，租户只能从 URL 拿', () => {
      expect(service.notifyUrlFor('ALIPAY', '01JC0K3V7Q8ZP5R2M9YB4XN6TA')).toBe(
        `${BASE}/api/public/pay/alipay/notify?tenant=01JC0K3V7Q8ZP5R2M9YB4XN6TA`,
      )
    })

    it('基址结尾的斜杠不会拼出双斜杠', () => {
      const s = new PaymentService(
        new ProviderRegistry([provider]),
        new StaticProviderConfigResolver(),
        normalizePaymentOptions(),
        'https://api.example.com/',
      )
      expect(s.notifyUrlFor('WECHAT')).toBe(`${BASE}/api/public/pay/wechat/notify`)
    })
  })

  describe('createOrder', () => {
    it('把 notifyUrl 交给 Provider，金额与描述原样透传', async () => {
      await service.createOrder({
        channel: 'WECHAT',
        outTradeNo: 'PLAN-ABC123',
        amountCents: 9900,
        description: '专业版 1 年',
        payer: { kind: 'openid', value: 'o-1' },
      })

      expect(provider.getOrder('PLAN-ABC123')).toMatchObject({
        amountCents: 9900,
        notifyUrl: `${BASE}/api/public/pay/wechat/notify`,
      })
    })

    it('金额不是正整数分直接拒（不要让渠道回一句看不懂的 PARAM_ERROR）', async () => {
      await expect(
        service.createOrder({
          channel: 'WECHAT',
          outTradeNo: 'PLAN-ABC124',
          amountCents: 0,
          description: 'x',
          payer: { kind: 'none' },
        }),
      ).rejects.toBeInstanceOf(BizException)
    })

    it('没装配的渠道抛 PROVIDER_NOT_FOUND', async () => {
      await expect(
        service.createOrder({
          channel: 'DOUYIN',
          outTradeNo: 'PLAN-ABC125',
          amountCents: 100,
          description: 'x',
          payer: { kind: 'none' },
        }),
      ).rejects.toThrow(/没有装配 Provider/)
    })
  })

  describe('refund', () => {
    beforeEach(async () => {
      await service.createOrder({
        channel: 'WECHAT',
        outTradeNo: 'PLAN-PAID01',
        amountCents: 10000,
        description: '专业版',
        payer: { kind: 'openid', value: 'o-1' },
      })
    })

    // 用例 ⑦
    it('退款金额超过已付 → 在调渠道之前就拒', async () => {
      await expect(
        service.refund({
          channel: 'WECHAT',
          outTradeNo: 'PLAN-PAID01',
          paidCents: 10000,
          refundCents: 10001,
        }),
      ).rejects.toMatchObject({ code: PAYMENT_ERROR.BAD_REQUEST.code })
      // 渠道侧一笔退款记录都不该产生：这一步必须发生在调渠道之前，
      // 因为退多了的钱要不回来（渠道回的 PARAM_ERROR 也看不出是金额关系不对）。
      expect(provider.getOrder('PLAN-PAID01')?.state).toBe('NOTPAY')
    })

    it('分次退款累计超过已付也要拒（各自都合法、加起来超了是最容易漏的那种）', async () => {
      await expect(
        service.refund({
          channel: 'WECHAT',
          outTradeNo: 'PLAN-PAID01',
          paidCents: 10000,
          refundedCents: 6000,
          refundCents: 5000,
        }),
      ).rejects.toMatchObject({ code: PAYMENT_ERROR.BAD_REQUEST.code })
    })

    it('退款金额必须是正整数分', async () => {
      for (const refundCents of [0, -1, 12.5]) {
        await expect(
          service.refund({
            channel: 'WECHAT',
            outTradeNo: 'PLAN-PAID01',
            paidCents: 10000,
            refundCents,
          }),
        ).rejects.toBeInstanceOf(BizException)
      }
    })

    it('金额合法时生成 RFD- 单号、带上退款回调地址并调渠道', async () => {
      const res = await service.refund({
        channel: 'WECHAT',
        outTradeNo: 'PLAN-PAID01',
        paidCents: 10000,
        refundCents: 3000,
        reason: '用户申请',
      })

      expect(res.outRefundNo).toMatch(/^RFD-[0-9A-Z]{26}$/)
      expect(res.status).toBe('SUCCESS')
      expect(provider.getRefund(res.outRefundNo)).toMatchObject({
        outTradeNo: 'PLAN-PAID01',
        refundCents: 3000,
        totalCents: 10000,
      })
    })

    it('传了 outRefundNo 就复用它（同一笔退款重试换单号 = 退两次钱）', async () => {
      const first = await service.refund({
        channel: 'WECHAT',
        outTradeNo: 'PLAN-PAID01',
        paidCents: 10000,
        refundCents: 3000,
        outRefundNo: 'RFD-FIXED01',
      })
      const retry = await service.refund({
        channel: 'WECHAT',
        outTradeNo: 'PLAN-PAID01',
        paidCents: 10000,
        refundCents: 3000,
        outRefundNo: 'RFD-FIXED01',
      })

      expect(retry.outRefundNo).toBe('RFD-FIXED01')
      expect(retry.refundId).toBe(first.refundId)
    })
  })

  describe('queryOrder', () => {
    it('查无此单按「没付过」处理', async () => {
      await expect(
        service.queryOrder({ channel: 'WECHAT', outTradeNo: 'PLAN-NOPE' }),
      ).resolves.toEqual({ state: 'NOTPAY' })
    })
  })
})
