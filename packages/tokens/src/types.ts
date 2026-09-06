import type { Palette } from './palette'
import type { Spacing } from './spacing'
import type { Typography } from './typography'
import type { Radius } from './radius'
import type { Shadow } from './shadow'

/**
 * 汇总后的 token 树形状。单独放一个文件是为了让 `to-antd.ts`/`to-scss.ts`/`to-rn.ts`
 * 与 `index.ts` 都能引用同一个类型，而不产生 `index.ts` ↔ `to-*.ts` 的循环导入。
 */
export interface TokenTree {
  palette: Palette
  spacing: Spacing
  typography: Typography
  radius: Radius
  shadow: Shadow
}
