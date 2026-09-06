import { describe, expect, it } from 'vitest'

import { assertCents, formatCents, parseToCents } from './money'

describe('formatCents', () => {
  it('整数分转元', () => {
    expect(formatCents(1234)).toBe('12.34')
  })

  it('0 分格式化为 0.00', () => {
    expect(formatCents(0)).toBe('0.00')
  })

  it('负数带负号', () => {
    expect(formatCents(-1234)).toBe('-12.34')
  })

  it('个位分补零', () => {
    expect(formatCents(5)).toBe('0.05')
    expect(formatCents(100)).toBe('1.00')
  })

  it('grouping 加千分位', () => {
    expect(formatCents(123456789, { grouping: true })).toBe('1,234,567.89')
  })

  it('currencySymbol 加前缀', () => {
    expect(formatCents(1234, { currencySymbol: '¥' })).toBe('¥12.34')
  })

  it('非整数分抛错', () => {
    expect(() => formatCents(1.5)).toThrow()
  })
})

describe('parseToCents', () => {
  it('标准两位小数', () => {
    expect(parseToCents('12.34')).toBe(1234)
  })

  it('整数（无小数点）', () => {
    expect(parseToCents('12')).toBe(1200)
  })

  it('0', () => {
    expect(parseToCents('0')).toBe(0)
  })

  it("'0.1' 补齐为一位小数换算成 10 分", () => {
    expect(parseToCents('0.1')).toBe(10)
  })

  it('负数', () => {
    expect(parseToCents('-1.5')).toBe(-150)
  })

  it("'-0.00' 不产出 -0", () => {
    expect(Object.is(parseToCents('-0.00'), -0)).toBe(false)
    expect(parseToCents('-0.00')).toBe(0)
  })

  it('带千分位分隔符可解析', () => {
    expect(parseToCents('1,234.56')).toBe(123456)
  })

  it('拒绝科学计数法', () => {
    expect(() => parseToCents('1e2')).toThrow()
  })

  it('拒绝超过两位小数', () => {
    expect(() => parseToCents('1.234')).toThrow()
  })

  it('拒绝非数字字符串', () => {
    expect(() => parseToCents('abc')).toThrow()
    expect(() => parseToCents('')).toThrow()
  })

  it('拒绝超出安全整数范围的金额', () => {
    expect(() => parseToCents('99999999999999.99')).toThrow()
  })
})

describe('assertCents', () => {
  it('安全整数（含 0 与负数）不抛错', () => {
    expect(() => assertCents(0)).not.toThrow()
    expect(() => assertCents(100)).not.toThrow()
    expect(() => assertCents(-100)).not.toThrow()
  })

  it('非整数抛错', () => {
    expect(() => assertCents(1.5)).toThrow()
  })

  it('超出安全整数范围抛错', () => {
    expect(() => assertCents(Number.MAX_SAFE_INTEGER + 10)).toThrow()
  })
})
