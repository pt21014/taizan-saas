/**
 * 字号/字重/行高单一真源。`fontSize`/`lineHeight` 用无单位数字（px 基准值，RN 直接用，
 * Web 侧映射时拼 `px`）；`fontWeight` 用字符串数字（CSS 与 RN 的 `fontWeight` 都吃这个格式，
 * 用数字反而在 RN 侧要额外转字符串）。
 */
export const typography = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: {
    xs: 12,
    sm: 13,
    md: 14,
    lg: 16,
    xl: 20,
    xxl: 24,
  },
  fontWeight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.75,
  },
} as const

export type Typography = typeof typography
