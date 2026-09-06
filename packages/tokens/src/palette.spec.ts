import { describe, expect, it } from 'vitest'
import { palette } from './palette'

const HEX_RE = /^#[0-9A-Fa-f]{6}$/

describe('palette', () => {
  it('gray/brand 全部是合法的 6 位十六进制颜色', () => {
    for (const [key, value] of Object.entries(palette.gray)) {
      expect(value, `gray.${key}`).toMatch(HEX_RE)
    }
    for (const [key, value] of Object.entries(palette.brand)) {
      expect(value, `brand.${key}`).toMatch(HEX_RE)
    }
  })

  it('semantic 四色（success/warning/error/info）各自的 light/base/dark 都是合法颜色', () => {
    const keys = ['success', 'warning', 'error', 'info'] as const
    for (const key of keys) {
      const color = palette.semantic[key]
      expect(color.light, `semantic.${key}.light`).toMatch(HEX_RE)
      expect(color.base, `semantic.${key}.base`).toMatch(HEX_RE)
      expect(color.dark, `semantic.${key}.dark`).toMatch(HEX_RE)
    }
  })
})
