import type { TokenTree } from './types'

function line(name: string, value: string | number): string {
  return `$${name}: ${value};`
}

/**
 * token 树 → SCSS 变量文本（蓝图 §T3-1 三向映射之一），供 Taro 端（`@taizan/client-core`）
 * 用 `@use` 引入。返回一整段可直接写入 `.scss` 文件的文本，不落盘——落盘由调用方（生成器/
 * 构建脚本）决定放在哪个路径。
 *
 * 变量命名前缀固定 `taizan-`，`color-*` 系列的键名与 {@link toAntdTheme}/{@link toRNTokens}
 * 暴露的颜色键保持同名（`primary/success/warning/error/info`），三者的完整性由
 * `to-antd.spec.ts`/`to-scss.spec.ts`/`to-rn.spec.ts` 共用同一份 `SEMANTIC_COLOR_KEYS` 断言。
 */
export function toScssVariables(t: TokenTree): string {
  const lines: string[] = [
    '// 本文件由 @taizan/tokens 的 toScssVariables() 生成，不要手改，改 palette.ts 等源文件后重新生成。',
    '',
    '// 颜色',
    line('taizan-color-primary', t.palette.brand[500]),
    line('taizan-color-success', t.palette.semantic.success.base),
    line('taizan-color-warning', t.palette.semantic.warning.base),
    line('taizan-color-error', t.palette.semantic.error.base),
    line('taizan-color-info', t.palette.semantic.info.base),
    line('taizan-color-text', t.palette.gray[900]),
    line('taizan-color-bg', t.palette.gray[0]),
    '',
    '// 间距',
    ...Object.entries(t.spacing).map(([key, value]) => line(`taizan-spacing-${key}`, `${value}px`)),
    '',
    '// 字号',
    line('taizan-font-family', t.typography.fontFamily),
    ...Object.entries(t.typography.fontSize).map(([key, value]) =>
      line(`taizan-font-size-${key}`, `${value}px`),
    ),
    '',
    '// 圆角',
    ...Object.entries(t.radius).map(([key, value]) => line(`taizan-radius-${key}`, `${value}px`)),
    '',
    '// 阴影',
    ...Object.entries(t.shadow).map(([key, value]) => line(`taizan-shadow-${key}`, value.web)),
  ]
  return lines.join('\n') + '\n'
}
