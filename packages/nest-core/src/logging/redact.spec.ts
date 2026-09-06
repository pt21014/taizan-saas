import { describe, expect, it } from 'vitest'
import { classifyKey, maskPhone, REDACTED, redactObject } from './redact'

describe('classifyKey', () => {
  it.each([
    'password',
    'Password',
    'secret',
    'token',
    'authorization',
    'idCard',
    'id_card',
    'clientSecret',
    'APP_SECRET',
    'valueEnc',
    'tokenEnc',
    'refreshToken',
    'apiKey',
    'cookie',
  ])('%s 整个抹掉', (key) => {
    expect(classifyKey(key)).toBe('redact')
  })

  it.each(['phone', 'Phone', 'userPhone', 'mobile', 'contactTel'])('%s 打码', (key) => {
    expect(classifyKey(key)).toBe('mask-phone')
  })

  it.each(['name', 'tenantId', 'encoding', 'secretary'])('%s 保留', (key) => {
    // `encoding` 不该因为含 enc 被抹（是后缀匹配不是包含匹配），
    // `secretary` 同理——包含匹配会把一堆正常字段误伤成 [REDACTED]，日志就没法看了
    expect(classifyKey(key)).toBe('keep')
  })
})

describe('maskPhone', () => {
  // 用例⑫（后半）：手机号中间打码，前 3 后 4 保留
  it('11 位手机号只留前 3 后 4', () => {
    expect(maskPhone('13812345678')).toBe('138****5678')
  })

  it('长度不足 8 位的整个抹掉（留前 3 后 4 等于几乎全留）', () => {
    expect(maskPhone('1234567')).toBe(REDACTED)
    expect(maskPhone('123')).toBe(REDACTED)
  })

  it('数字类型也能打码', () => {
    expect(maskPhone(13812345678)).toBe('138****5678')
  })

  it('非字符串非数字一律抹掉', () => {
    expect(maskPhone({ a: 1 })).toBe(REDACTED)
    expect(maskPhone(null)).toBe(REDACTED)
  })
})

describe('redactObject', () => {
  it('深层嵌套的敏感字段一并处理', () => {
    const input = {
      user: { name: '张三', phone: '13812345678', password: 'hunter2' },
      tenant: { credential: { valueEnc: 'AAAA', keyId: 'k1' } },
      headers: { authorization: 'Bearer abc' },
      list: [{ mobile: '15900001111' }],
    }
    const out = redactObject(input)
    expect(out).toEqual({
      user: { name: '张三', phone: '138****5678', password: REDACTED },
      tenant: { credential: { valueEnc: REDACTED, keyId: 'k1' } },
      headers: { authorization: REDACTED },
      list: [{ mobile: '159****1111' }],
    })
  })

  it('不修改入参', () => {
    const input = { password: 'hunter2' }
    redactObject(input)
    expect(input.password).toBe('hunter2')
  })

  it('循环引用不炸', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(redactObject(a)).toEqual({ name: 'a', self: '[Circular]' })
  })

  it('Error 原样保留（别把堆栈拆没了）', () => {
    const err = new Error('boom')
    const out = redactObject({ err })
    expect((out as { err: Error }).err).toBe(err)
  })

  it('超深结构被截断', () => {
    let deep: Record<string, unknown> = { end: 1 }
    for (let i = 0; i < 20; i++) {
      deep = { next: deep }
    }
    expect(JSON.stringify(redactObject(deep))).toContain('[Truncated]')
  })
})
