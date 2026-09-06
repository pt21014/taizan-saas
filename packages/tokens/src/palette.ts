/**
 * 色板单一真源（蓝图 §5.4/§T3-1）：中性品牌色（不含具体业务品牌调性，业务侧可整体替换
 * `brand` 这一支）+ 语义色（success/warning/error/info）+ 灰阶。
 *
 * 全部使用 6 位大写十六进制（`#RRGGBB`），不带 alpha——三向映射（AntD/SCSS/RN）都按这个
 * 格式解析，混入 8 位或 `rgb()` 会让 `to-rn.ts` 的颜色解析多一层分支。
 */

/** 十三阶灰阶，从纯白到纯黑，供背景/边框/文字三类场景取用。 */
export const gray = {
  0: '#FFFFFF',
  50: '#F7F8FA',
  100: '#F0F1F3',
  200: '#E4E6EB',
  300: '#D0D3D9',
  400: '#B0B4BC',
  500: '#8A8F98',
  600: '#6B7078',
  700: '#4D5158',
  800: '#33363B',
  900: '#1C1E21',
  1000: '#000000',
} as const

/**
 * 中性品牌色阶。「中性」指刻意不选高饱和度的行业色（不是餐饮红、不是教育橙），
 * 生成器铺出来的项目默认长这样，业务方接手后按自己的 VI 整体替换这一支即可，
 * 其余四个语义色与灰阶不受影响。
 */
export const brand = {
  50: '#EEF2FF',
  100: '#E0E7FF',
  200: '#C7D2FE',
  300: '#A5B4FC',
  400: '#818CF8',
  500: '#6366F1',
  600: '#4F46E5',
  700: '#4338CA',
  800: '#3730A3',
  900: '#312E81',
} as const

/** 单个语义色的三档：默认 / 浅色背景 / 深色强调。 */
export interface SemanticColor {
  light: string
  base: string
  dark: string
}

/**
 * 语义色：成功/警告/错误/信息。四端错误码分流（§4.9）与表单校验状态都从这四个键取色，
 * 键名固定为 `success/warning/error/info`——三向映射的完整性测试按这四个键断言。
 */
export const semantic = {
  success: { light: '#E6F7ED', base: '#16A34A', dark: '#0F7A38' } satisfies SemanticColor,
  warning: { light: '#FFF7E6', base: '#F59E0B', dark: '#B45309' } satisfies SemanticColor,
  error: { light: '#FEECEC', base: '#DC2626', dark: '#A31515' } satisfies SemanticColor,
  info: { light: '#E6F1FF', base: '#2563EB', dark: '#1D4ED8' } satisfies SemanticColor,
} as const

export const palette = { gray, brand, semantic } as const

export type Palette = typeof palette
