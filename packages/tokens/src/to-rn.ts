import type { TokenTree } from './types'
import type { RNShadow } from './shadow'

/** RN 端消费的颜色扁平表：与 {@link AntdThemeToken}/`to-scss.ts` 的语义色键名保持一致。 */
export interface RNColors {
  primary: string
  success: string
  warning: string
  error: string
  info: string
  textBase: string
  bgBase: string
  gray: Record<string, string>
}

/** RN `StyleSheet.create` 友好的字号/字重形状：全是数字/字符串数字，不带 `px`。 */
export interface RNTypography {
  fontFamily: string
  fontSize: Record<string, number>
  fontWeight: Record<string, string>
  lineHeight: Record<string, number>
}

/** token 树 → RN 友好对象（蓝图 §T3-1 三向映射之一），供 `@taizan/app-ui`（Expo）消费。 */
export interface RNTokens {
  colors: RNColors
  spacing: Record<string, number>
  typography: RNTypography
  radius: Record<string, number>
  shadow: Record<string, RNShadow>
}

/**
 * token 树 → RN 友好对象。所有数值保持无单位数字（RN 样式值本来就无单位），
 * 阴影取 `shadow.*.rn` 那一支——RN 没有 `box-shadow`，只能拆成
 * `shadowColor/shadowOffset/shadowOpacity/shadowRadius/elevation` 几个独立属性。
 */
export function toRNTokens(t: TokenTree): RNTokens {
  return {
    colors: {
      primary: t.palette.brand[500],
      success: t.palette.semantic.success.base,
      warning: t.palette.semantic.warning.base,
      error: t.palette.semantic.error.base,
      info: t.palette.semantic.info.base,
      textBase: t.palette.gray[900],
      bgBase: t.palette.gray[0],
      gray: Object.fromEntries(Object.entries(t.palette.gray).map(([k, v]) => [k, v])),
    },
    spacing: { ...t.spacing },
    typography: {
      fontFamily: t.typography.fontFamily,
      fontSize: { ...t.typography.fontSize },
      fontWeight: { ...t.typography.fontWeight },
      lineHeight: { ...t.typography.lineHeight },
    },
    radius: { ...t.radius },
    shadow: Object.fromEntries(Object.entries(t.shadow).map(([k, v]) => [k, v.rn])),
  }
}
