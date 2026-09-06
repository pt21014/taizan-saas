import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  buildOtpauthUrl,
  generateTotpSecret,
  totp,
  verifyTotp,
} from './totp'

describe('totp（RFC 6238 手写最小实现，见文件头「为什么不用 otplib」）', () => {
  it('base32 编解码往返一致', () => {
    const buf = Buffer.from('hello totp secret bytes')
    expect(base32Decode(base32Encode(buf))).toEqual(buf)
  })

  it('generateTotpSecret 生成的是合法 base32（只含大写字母与 2-7）', () => {
    const secret = generateTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]+$/)
    expect(secret.length).toBeGreaterThan(0)
  })

  it('同一时刻算出的六位码可以被 verifyTotp 校验通过', () => {
    const secret = generateTotpSecret()
    const now = Date.now()
    const code = totp(secret, now)
    expect(code).toMatch(/^\d{6}$/)
    expect(verifyTotp(secret, code, { at: now })).toBe(true)
  })

  it('前后一个时间步（30s）之内仍然算通过（时钟容错窗口）', () => {
    const secret = generateTotpSecret()
    const now = Date.now()
    const code = totp(secret, now)
    expect(verifyTotp(secret, code, { at: now + 30_000 })).toBe(true)
    expect(verifyTotp(secret, code, { at: now - 30_000 })).toBe(true)
  })

  it('超出窗口（3 个时间步开外）校验失败', () => {
    const secret = generateTotpSecret()
    const now = Date.now()
    const code = totp(secret, now)
    expect(verifyTotp(secret, code, { at: now + 3 * 30_000 })).toBe(false)
  })

  it('错误的码 / 格式不对的输入一律 false，不抛异常', () => {
    const secret = generateTotpSecret()
    expect(verifyTotp(secret, '000000')).toBe(false)
    expect(verifyTotp(secret, 'abcdef')).toBe(false)
    expect(verifyTotp(secret, '12345')).toBe(false)
    expect(verifyTotp(secret, '')).toBe(false)
  })

  it('不同 secret 生成的码不同（不会串号）', () => {
    const now = Date.now()
    const a = totp(generateTotpSecret(), now)
    const b = totp(generateTotpSecret(), now)
    // 理论上有 1/1e6 概率恰好相等，但两次随机 secret 撞码的概率可忽略不计。
    expect(a === b).toBe(false)
  })

  it('buildOtpauthUrl 拼出合法的 otpauth://totp/ URL，带 issuer/secret/period', () => {
    const secret = generateTotpSecret()
    const url = buildOtpauthUrl(secret, { issuer: 'Taizan', accountName: 'admin' })
    expect(url.startsWith('otpauth://totp/Taizan%3Aadmin?')).toBe(true)
    const query = new URL(url).searchParams
    expect(query.get('secret')).toBe(secret)
    expect(query.get('issuer')).toBe('Taizan')
    expect(query.get('period')).toBe('30')
    expect(query.get('digits')).toBe('6')
  })
})
