/**
 * 间距单一真源：全部是无单位数字（px 基准值），三向映射各自决定怎么拼单位——
 * AntD/SCSS 拼 `px`，RN 直接用数字（RN 的样式值本来就是无单位）。
 */
export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const

export type Spacing = typeof spacing
export type SpacingKey = keyof Spacing
