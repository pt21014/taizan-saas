import { ERROR_DOMAIN, domainOf, httpSemantic } from '@taizan/contracts'
import { describe, expect, it } from 'vitest'

import { CallbackParseError, PAYMENT_ERROR, PaymentError, SignatureError } from './errors'

describe('PAYMENT_ERROR 码表', () => {
  it('每一条都落在 16（支付）域段，且是 7 位', () => {
    for (const [key, def] of Object.entries(PAYMENT_ERROR)) {
      expect(domainOf(def.code), key).toBe(ERROR_DOMAIN.PAYMENT)
      expect(String(def.code), key).toHaveLength(7)
    }
  })

  it('HTTP 语义段与「谁的错」对得上：伪造回调是 400，上游挂了是 500，查无此单是 404', () => {
    expect(httpSemantic(PAYMENT_ERROR.SIGNATURE_INVALID.code)).toBe(400)
    expect(httpSemantic(PAYMENT_ERROR.CALLBACK_PARSE_FAILED.code)).toBe(400)
    expect(httpSemantic(PAYMENT_ERROR.ORDER_NOT_FOUND.code)).toBe(404)
    expect(httpSemantic(PAYMENT_ERROR.UPSTREAM_ERROR.code)).toBe(500)
  })

  it('码值互不重复', () => {
    const codes = Object.values(PAYMENT_ERROR).map((d) => d.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('错误类型', () => {
  it('PaymentError 带码、带 detail、instanceof Error', () => {
    const e = PaymentError.of(PAYMENT_ERROR.UPSTREAM_ERROR, '微信超时', { requestId: 'r1' })
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe(PAYMENT_ERROR.UPSTREAM_ERROR.code)
    expect(e.message).toBe('微信超时')
    expect(e.detail).toEqual({ requestId: 'r1' })
    expect(e.name).toBe('PaymentError')
  })

  it('不传 message 时用码表里的默认提示', () => {
    expect(PaymentError.of(PAYMENT_ERROR.ORDER_NOT_FOUND).message).toBe('支付订单不存在')
  })

  it('SignatureError 与 CallbackParseError 是两个可分辨的类型', () => {
    const sig = new SignatureError()
    const parse = new CallbackParseError()
    expect(sig).toBeInstanceOf(PaymentError)
    expect(parse).toBeInstanceOf(PaymentError)
    // 两者的运维含义相反：验签失败报警给安全，解析失败报警给开发，
    // 所以上层必须能用 instanceof 分开
    expect(sig).not.toBeInstanceOf(CallbackParseError)
    expect(parse).not.toBeInstanceOf(SignatureError)
    expect(sig.code).toBe(PAYMENT_ERROR.SIGNATURE_INVALID.code)
    expect(parse.code).toBe(PAYMENT_ERROR.CALLBACK_PARSE_FAILED.code)
  })
})
