import { describe, expect, it } from 'vitest'

import { colors, radius, shadow, spacing, textVariants, typography, withAlpha } from './tokens'

describe('tokens：三向映射的 RN 支必须键完整', () => {
  it('colors 覆盖全部语义色 + 灰阶', () => {
    for (const key of [
      'primary',
      'success',
      'warning',
      'error',
      'info',
      'textBase',
      'bgBase',
    ] as const) {
      expect(typeof colors[key]).toBe('string')
      expect(colors[key].length).toBeGreaterThan(0)
    }
    expect(colors.gray[0]).toBeTypeOf('string')
    expect(colors.gray[900]).toBeTypeOf('string')
  })

  it('spacing 键与 @taizan/tokens 的 spacing 一致', () => {
    for (const key of ['none', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'xxxl'] as const) {
      expect(typeof spacing[key]).toBe('number')
    }
  })

  it('radius 键完整', () => {
    for (const key of ['none', 'sm', 'md', 'lg', 'full'] as const) {
      expect(typeof radius[key]).toBe('number')
    }
  })

  it('shadow 三档（sm/md/lg）都拆成了 RN 的四个属性 + elevation', () => {
    for (const key of ['sm', 'md', 'lg'] as const) {
      const level = shadow[key]
      expect(level).toHaveProperty('shadowColor')
      expect(level).toHaveProperty('shadowOffset')
      expect(level).toHaveProperty('shadowOpacity')
      expect(level).toHaveProperty('shadowRadius')
      expect(level).toHaveProperty('elevation')
    }
  })

  it('typography.lineHeight 是倍率，不是绝对像素（RN 需要换算）', () => {
    expect(typography.lineHeight.normal).toBeCloseTo(1.5)
  })

  it('textVariants 把倍率换算成了绝对像素，且不小于 fontSize', () => {
    for (const key of ['display', 'title', 'head', 'body', 'sub', 'micro'] as const) {
      const v = textVariants[key]
      expect(v.lineHeight).toBeGreaterThanOrEqual(v.fontSize)
      expect(Number.isInteger(v.lineHeight)).toBe(true)
    }
  })

  it('withAlpha 把 6 位 hex 转成 rgba，3 位 hex 也能展开', () => {
    expect(withAlpha('#6366F1', 0.5)).toBe('rgba(99,102,241,0.5)')
    expect(withAlpha('#fff', 0.2)).toBe('rgba(255,255,255,0.2)')
  })

  it('withAlpha 对非法输入回落到品牌色，不抛异常', () => {
    expect(withAlpha('not-a-color', 0.3)).toMatch(/^rgba\(/)
  })
})
