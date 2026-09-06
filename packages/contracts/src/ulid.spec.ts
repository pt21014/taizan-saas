import { describe, expect, it } from 'vitest'

import { isUlid, ulid, ulidTime } from './ulid'

describe('ulid', () => {
  it('生成 26 位字符串', () => {
    expect(ulid()).toHaveLength(26)
  })

  it('生成结果通过 isUlid 校验', () => {
    expect(isUlid(ulid())).toBe(true)
  })

  it('同一毫秒内连续调用单调递增（字典序）', () => {
    const fixedTime = 1_700_000_000_000
    const a = ulid(fixedTime)
    const b = ulid(fixedTime)
    const c = ulid(fixedTime)
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
    // 时间戳前缀（前 10 位）在同一毫秒内应保持一致
    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(b.slice(0, 10)).toBe(c.slice(0, 10))
  })

  it('不同毫秒之间也保持字典序递增', () => {
    const a = ulid(1_700_000_000_000)
    const b = ulid(1_700_000_000_001)
    expect(a < b).toBe(true)
  })
})

describe('isUlid', () => {
  it('拒绝错误长度', () => {
    expect(isUlid('TOO_SHORT')).toBe(false)
    expect(isUlid(`${ulid()}X`)).toBe(false)
  })

  it('拒绝 Crockford Base32 之外的字符（I/L/O/U 不合法）', () => {
    expect(isUlid('0IIIIIIIIIIIIIIIIIIIIIIIII')).toBe(false)
    expect(isUlid('0LLLLLLLLLLLLLLLLLLLLLLLLL')).toBe(false)
    expect(isUlid('0OOOOOOOOOOOOOOOOOOOOOOOOO')).toBe(false)
    expect(isUlid('0UUUUUUUUUUUUUUUUUUUUUUUUU')).toBe(false)
  })

  it('接受合法字符集的大小写混合', () => {
    const id = ulid()
    expect(isUlid(id.toLowerCase())).toBe(true)
  })
})

describe('ulidTime', () => {
  it('还原出生成时传入的毫秒时间戳', () => {
    const fixedTime = 1_700_000_000_123
    const id = ulid(fixedTime)
    expect(ulidTime(id)).toBe(fixedTime)
  })

  it('对非法 ULID 抛出', () => {
    expect(() => ulidTime('not-a-ulid')).toThrow()
  })
})
