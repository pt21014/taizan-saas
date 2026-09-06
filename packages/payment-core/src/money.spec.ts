import { describe, expect, it } from 'vitest'

import { calcCommissionCents, splitAmount } from './money'

describe('splitAmount', () => {
  it('整除时按权重平均分', () => {
    expect(splitAmount(1000, [1, 1])).toEqual([500, 500])
    expect(splitAmount(999, [7, 3])).toEqual([700, 299])
  })

  it('除不尽时余数给第一份，总和仍然等于原额', () => {
    expect(splitAmount(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(splitAmount(1, [1, 1])).toEqual([1, 0])
  })

  it('权重是相对值，等比放大缩小结果相同', () => {
    expect(splitAmount(12345, [7, 3])).toEqual(splitAmount(12345, [70, 30]))
    expect(splitAmount(12345, [7, 3])).toEqual(splitAmount(12345, [0.7, 0.3]))
  })

  it('0 元与单份是边界但不特殊', () => {
    expect(splitAmount(0, [1, 2])).toEqual([0, 0])
    expect(splitAmount(777, [5])).toEqual([777])
  })

  it('权重为 0 的那份就是 0 分，但仍占一个位置', () => {
    expect(splitAmount(100, [1, 0, 1])).toEqual([50, 0, 50])
  })

  it('非法入参当场抛，不静默产出一个会被微信拒的金额', () => {
    expect(() => splitAmount(10.5, [1])).toThrow()
    expect(() => splitAmount(-1, [1])).toThrow(/不能为负/)
    expect(() => splitAmount(100, [])).toThrow(/至少需要一个权重/)
    expect(() => splitAmount(100, [0, 0])).toThrow(/不能全为 0/)
    expect(() => splitAmount(100, [1, -1])).toThrow(/非负/)
    expect(() => splitAmount(100, [1, Number.NaN])).toThrow(/非负/)
  })

  /**
   * 属性式：随机金额 × 随机权重，**总和必须恒等于原额**。
   *
   * 这条不变量是分账的生命线——各份加起来多一分，微信会回「分账金额超过可分金额」
   * 让整笔分账失败，而不是少分一分。用固定种子的伪随机保证失败可复现。
   */
  it('属性：任意金额与权重下，拆分总和恒等于原额（1000 组）', () => {
    let seed = 20260905
    const rnd = () => {
      // xorshift32，固定种子 → 失败时可原样复现
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 0xffffffff
    }

    for (let round = 0; round < 1000; round++) {
      const total = Math.floor(rnd() * 1_000_000)
      const n = 1 + Math.floor(rnd() * 8)
      const weights = Array.from({ length: n }, () => rnd() * 100)
      const parts = splitAmount(total, weights)

      expect(parts).toHaveLength(n)
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
      for (const p of parts) {
        expect(Number.isInteger(p)).toBe(true)
        expect(p).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('calcCommissionCents', () => {
  it('按万分比向下取整——宁可平台少收一分，也不能超过可分余额', () => {
    expect(calcCommissionCents(10_000, 1000)).toBe(1000)
    expect(calcCommissionCents(999, 1000)).toBe(99) // 99.9 → 99
  })

  it('默认封顶 30%：微信规定单笔分账不得超过订单金额的 30%', () => {
    expect(calcCommissionCents(10_000, 9999)).toBe(3000)
    expect(calcCommissionCents(10_000, 3000)).toBe(3000)
  })

  it('非正数入参一律返回 0，不返回 NaN', () => {
    expect(calcCommissionCents(0, 1000)).toBe(0)
    expect(calcCommissionCents(100, 0)).toBe(0)
    expect(calcCommissionCents(-100, 1000)).toBe(0)
    expect(calcCommissionCents(Number.NaN, 1000)).toBe(0)
  })
})
