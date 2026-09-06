/**
 * design token（蓝图 §5.4）：直接取 `@taizan/tokens` 的 `toRNTokens()`，
 * 不在这里重新定义一份颜色/间距常量——三向映射（AntD/SCSS/RN）只有一份真源。
 *
 * 在此基础上加一层「文本变体」：`@taizan/tokens` 的 `typography.lineHeight`
 * 是无单位的倍率（1.25/1.5/1.75），RN `Text` 的 `lineHeight` 却要绝对像素值，
 * 换算这一步只做一次，组件不用各自心算。
 */
import {
  tokens,
  toRNTokens,
  type Radius,
  type RNShadow,
  type RNTokens,
  type Spacing,
  type Typography,
} from '@taizan/tokens'

/** RN 友好的完整 token 树。 */
export const rnTokens: RNTokens = toRNTokens(tokens)

export const colors = rnTokens.colors

/**
 * `RNTokens` 里 `spacing`/`radius`/`typography`/`shadow` 的接口形状故意写成
 * `Record<string, ...>`（给三向映射的类型留通用性），但 `toRNTokens()` 实际上是原样
 * 浅拷贝/映射 `@taizan/tokens` 那份 `as const` 字面量对象——键集合是稳定的。
 * 这里转回字面量类型，换来 `spacing.lg`/`radius.md` 这类访问在
 * `noUncheckedIndexedAccess` 下不必到处 `?? fallback`。
 */
export const spacing = rnTokens.spacing as unknown as Spacing
export const radius = rnTokens.radius as unknown as Radius
export const typography = rnTokens.typography as unknown as Typography
export const shadow = rnTokens.shadow as unknown as Record<'sm' | 'md' | 'lg', RNShadow>

/** 触摸目标最小尺寸——iOS HIG 与 Material 都是这个数，低于它的按钮在真机上很难点中。 */
export const HIT_MIN = 44

export interface TextVariant {
  fontSize: number
  lineHeight: number
  fontWeight: string
}

type FontWeightKey = keyof typeof typography.fontWeight
type LineHeightKey = keyof typeof typography.lineHeight

function variant(fontSize: number, weight: FontWeightKey, leading: LineHeightKey): TextVariant {
  return {
    fontSize,
    lineHeight: Math.round(fontSize * typography.lineHeight[leading]),
    fontWeight: typography.fontWeight[weight],
  }
}

/** 常用文本层级，键名与用法对齐 knowledge 的 `type.*`，值全部来自 token 换算。 */
export const textVariants = {
  display: variant(typography.fontSize.xxl, 'bold', 'tight'),
  title: variant(typography.fontSize.xl, 'bold', 'tight'),
  head: variant(typography.fontSize.lg, 'semibold', 'normal'),
  body: variant(typography.fontSize.md, 'regular', 'relaxed'),
  sub: variant(typography.fontSize.sm, 'regular', 'normal'),
  micro: variant(typography.fontSize.xs, 'regular', 'normal'),
} as const

export type TextVariantKey = keyof typeof textVariants

/** `#RRGGBB`/`#RGB` + 透明度 → `rgba()`。用于强调色的浅色背景（芯片、标签）。 */
export function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (h.length !== 6) return `rgba(99,102,241,${alpha})`
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}
