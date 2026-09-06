/**
 * 阴影单一真源。Web（AntD/SCSS）用 CSS `box-shadow` 字符串；RN 没有 `box-shadow`，
 * 只能拆成 `shadowColor/shadowOffset/shadowOpacity/shadowRadius` 四个属性外加 Android 的
 * `elevation`——所以每一档阴影同时带 `web` 与 `rn` 两种形状，`to-scss.ts`/`to-antd.ts` 取
 * `web`，`to-rn.ts` 取 `rn`，三向映射的 key 完整性测试按 `sm/md/lg` 三档断言。
 */
export interface RNShadow {
  shadowColor: string
  shadowOffset: { width: number; height: number }
  shadowOpacity: number
  shadowRadius: number
  elevation: number
}

export interface ShadowLevel {
  web: string
  rn: RNShadow
}

export const shadow = {
  sm: {
    web: '0 1px 2px rgba(0, 0, 0, 0.05)',
    rn: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    },
  },
  md: {
    web: '0 4px 8px rgba(0, 0, 0, 0.08)',
    rn: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 8,
      elevation: 4,
    },
  },
  lg: {
    web: '0 8px 24px rgba(0, 0, 0, 0.12)',
    rn: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 16,
      elevation: 8,
    },
  },
} as const satisfies Record<'sm' | 'md' | 'lg', ShadowLevel>

export type Shadow = typeof shadow
