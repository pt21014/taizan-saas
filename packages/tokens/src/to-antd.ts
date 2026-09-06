import type { TokenTree } from './types'

/**
 * AntD 5 `ThemeConfig` 的最小结构化子集。`@taizan/tokens` 零依赖，不能 `import type { ThemeConfig }
 * from 'antd'`——这个接口只声明 `@taizan/admin-ui` 的 `<TaizanConfigProvider>` 会用到的字段，
 * TS 结构化类型使得它可以直接赋给真正的 `antd` `ThemeConfig.token`，不需要类型来源一致。
 */
export interface AntdThemeToken {
  colorPrimary: string
  colorSuccess: string
  colorWarning: string
  colorError: string
  colorInfo: string
  colorTextBase: string
  colorBgBase: string
  borderRadius: number
  borderRadiusLG: number
  borderRadiusSM: number
  fontFamily: string
  fontSize: number
  fontSizeLG: number
  fontSizeSM: number
  fontSizeXL: number
  lineHeight: number
  paddingXS: number
  padding: number
  paddingLG: number
  marginXS: number
  margin: number
  marginLG: number
  boxShadow: string
  boxShadowSecondary: string
}

/** 对齐 AntD `ThemeConfig` 外层形状：`{ token }`。留出 `components` 位置供后续按需扩展。 */
export interface AntdThemeConfig {
  token: AntdThemeToken
}

/**
 * token 树 → AntD 5 `ThemeConfig`（蓝图 §T3-1 三向映射之一）。
 *
 * 只映射 `ConfigProvider` 的 `theme.token` 这一层——组件级覆盖（`theme.components`）
 * 属于业务定制，不该由 design token 单一真源代劳。
 */
export function toAntdTheme(t: TokenTree): AntdThemeConfig {
  return {
    token: {
      colorPrimary: t.palette.brand[500],
      colorSuccess: t.palette.semantic.success.base,
      colorWarning: t.palette.semantic.warning.base,
      colorError: t.palette.semantic.error.base,
      colorInfo: t.palette.semantic.info.base,
      colorTextBase: t.palette.gray[900],
      colorBgBase: t.palette.gray[0],
      borderRadius: t.radius.md,
      borderRadiusLG: t.radius.lg,
      borderRadiusSM: t.radius.sm,
      fontFamily: t.typography.fontFamily,
      fontSize: t.typography.fontSize.md,
      fontSizeLG: t.typography.fontSize.lg,
      fontSizeSM: t.typography.fontSize.sm,
      fontSizeXL: t.typography.fontSize.xl,
      lineHeight: t.typography.lineHeight.normal,
      paddingXS: t.spacing.xs,
      padding: t.spacing.md,
      paddingLG: t.spacing.lg,
      marginXS: t.spacing.xs,
      margin: t.spacing.md,
      marginLG: t.spacing.lg,
      boxShadow: t.shadow.md.web,
      boxShadowSecondary: t.shadow.sm.web,
    },
  }
}
