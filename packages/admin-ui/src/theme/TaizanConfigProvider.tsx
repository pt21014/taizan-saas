import type { ReactNode } from 'react'
import { ConfigProvider } from 'antd'
// 注意：antd 的 package.json 没有 "exports" 字段，Node ESM 严格解析不会像 CJS require
// 那样自动补 .js 后缀——真实 npm 安装（而非 workspace link）下 `antd/locale/zh_CN`
// 会报 ERR_MODULE_NOT_FOUND（T4-1）。显式带 .js 后缀在 Vite/Node ESM/Node CJS 三种场景
// 下都能解析（该文件是 CJS 的 `module.exports = require(...)`，ESM import 走 CJS 互操作
// 拿到 default）。见 scripts/check-dist-resolve.mjs。
import zhCN from 'antd/locale/zh_CN.js'
import { tokens as defaultTokens, toAntdTheme, type Tokens } from '@taizan/tokens'

export interface TaizanConfigProviderProps {
  /** 覆盖默认 design token（如业务方整体替换品牌色阶），缺省用 `@taizan/tokens` 的默认值 */
  tokens?: Tokens
  children: ReactNode
}

/**
 * 包一层 AntD `ConfigProvider`：`theme` 用 `@taizan/tokens` 的 `toAntdTheme()` 映射，
 * `locale` 固定中文——四端目前只服务国内商家，没有多语言需求前不引入 i18n 开关。
 */
export function TaizanConfigProvider({ tokens, children }: TaizanConfigProviderProps) {
  return (
    <ConfigProvider theme={toAntdTheme(tokens ?? defaultTokens)} locale={zhCN}>
      {children}
    </ConfigProvider>
  )
}
