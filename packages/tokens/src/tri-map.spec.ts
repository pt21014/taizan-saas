import { describe, expect, it } from 'vitest'
import { tokens } from './index'
import { toAntdTheme } from './to-antd'
import { toScssVariables } from './to-scss'
import { toRNTokens } from './to-rn'

const HEX_RE = /^#[0-9A-Fa-f]{6}$/

/**
 * 三向映射（AntD / SCSS / RN）的键完整性：语义色 `primary/success/warning/error/info`
 * 必须在三份产出里都能找到，且颜色格式必须是合法的 6 位十六进制——这是「单一真源」
 * 承诺的验收点，任何一份漏掉一个键都视为回归。
 */
const SEMANTIC_COLOR_KEYS = ['primary', 'success', 'warning', 'error', 'info'] as const

describe('三向映射键完整性', () => {
  const antd = toAntdTheme(tokens)
  const scss = toScssVariables(tokens)
  const rn = toRNTokens(tokens)

  it('AntD ThemeConfig 覆盖全部语义色，且均为合法颜色', () => {
    const map: Record<(typeof SEMANTIC_COLOR_KEYS)[number], string> = {
      primary: antd.token.colorPrimary,
      success: antd.token.colorSuccess,
      warning: antd.token.colorWarning,
      error: antd.token.colorError,
      info: antd.token.colorInfo,
    }
    for (const key of SEMANTIC_COLOR_KEYS) {
      expect(map[key], `antd.token.color${key}`).toMatch(HEX_RE)
    }
  })

  it('SCSS 变量文本覆盖全部语义色，且均为合法颜色', () => {
    for (const key of SEMANTIC_COLOR_KEYS) {
      const re = new RegExp(`\\$taizan-color-${key}:\\s*(#[0-9A-Fa-f]{6});`)
      const match = re.exec(scss)
      expect(match, `$taizan-color-${key} 未出现在 SCSS 输出中`).not.toBeNull()
      expect(match?.[1], `$taizan-color-${key}`).toMatch(HEX_RE)
    }
  })

  it('RN 友好对象覆盖全部语义色，且均为合法颜色', () => {
    const map: Record<(typeof SEMANTIC_COLOR_KEYS)[number], string> = {
      primary: rn.colors.primary,
      success: rn.colors.success,
      warning: rn.colors.warning,
      error: rn.colors.error,
      info: rn.colors.info,
    }
    for (const key of SEMANTIC_COLOR_KEYS) {
      expect(map[key], `rn.colors.${key}`).toMatch(HEX_RE)
    }
  })

  it('三份产出的语义色取值完全一致（同一份 palette.semantic 派生）', () => {
    expect(antd.token.colorSuccess).toBe(rn.colors.success)
    expect(antd.token.colorWarning).toBe(rn.colors.warning)
    expect(antd.token.colorError).toBe(rn.colors.error)
    expect(antd.token.colorInfo).toBe(rn.colors.info)

    const scssSuccess = /\$taizan-color-success:\s*(#[0-9A-Fa-f]{6});/.exec(scss)?.[1]
    expect(scssSuccess).toBe(antd.token.colorSuccess)
  })

  it('spacing/radius 的键在三份产出里数量一致', () => {
    const spacingKeys = Object.keys(tokens.spacing)
    for (const key of spacingKeys) {
      expect(rn.spacing, `rn.spacing.${key}`).toHaveProperty(key)
      expect(scss, `SCSS 缺少 spacing ${key}`).toContain(`taizan-spacing-${key}`)
    }
    const radiusKeys = Object.keys(tokens.radius)
    for (const key of radiusKeys) {
      expect(rn.radius, `rn.radius.${key}`).toHaveProperty(key)
      expect(scss, `SCSS 缺少 radius ${key}`).toContain(`taizan-radius-${key}`)
    }
  })

  it('shadow 的三档（sm/md/lg）在 AntD/SCSS/RN 三份产出里都能找到', () => {
    expect(antd.token.boxShadow).toBe(tokens.shadow.md.web)
    expect(antd.token.boxShadowSecondary).toBe(tokens.shadow.sm.web)
    for (const key of ['sm', 'md', 'lg'] as const) {
      expect(rn.shadow, `rn.shadow.${key}`).toHaveProperty(key)
      expect(scss, `SCSS 缺少 shadow ${key}`).toContain(`taizan-shadow-${key}`)
    }
  })
})
