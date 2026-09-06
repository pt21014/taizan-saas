/** 圆角单一真源，无单位数字（px 基准值）。`full` 用一个足够大的数字实现「胶囊」效果。 */
export const radius = {
  none: 0,
  sm: 2,
  md: 6,
  lg: 12,
  full: 9999,
} as const

export type Radius = typeof radius
