/**
 * `@taizan/tokens`：design token 单一真源（蓝图 §5.4/T3-1）。
 *
 * 零运行时依赖——`palette/spacing/typography/radius/shadow` 是唯一真源，
 * `to-antd`/`to-scss`/`to-rn` 是三个纯函数映射，供 `@taizan/admin-ui`（AntD）、
 * Taro 端（SCSS 变量）、`@taizan/app-ui`（Expo/RN）各自消费，不允许任何一端
 * 自己再定义一份颜色/间距常量。
 */
export * from './palette'
export * from './spacing'
export * from './typography'
export * from './radius'
export * from './shadow'

import { palette } from './palette'
import { spacing } from './spacing'
import { typography } from './typography'
import { radius } from './radius'
import { shadow } from './shadow'

/** 汇总后的完整 token 树，三个 `to-*` 映射函数的入参类型都以它为准。 */
export const tokens = {
  palette,
  spacing,
  typography,
  radius,
  shadow,
} as const

export type { TokenTree } from './types'
export type Tokens = typeof tokens

export * from './to-antd'
export * from './to-scss'
export * from './to-rn'
