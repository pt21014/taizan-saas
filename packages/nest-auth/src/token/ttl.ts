/**
 * token 有效期配置。
 *
 * 默认值的取舍（三套差这么多是有理由的，别随手拉齐）：
 *
 * | kind | access | 理由 |
 * |---|---|---|
 * | platform | 4h | 权限最大、影响面最广，被盗代价最高，短到「下班回来要重登」为止 |
 * | staff | 8h | 一个工作班次。太短会在收银高峰弹登录框，那是会丢单的 |
 * | member | 7d | C 端体验优先；会员能做的事有限，且随时可 `revokeAll` |
 *
 * refresh 统一 30 天：它一次性轮换（用掉即失效），被盗后重放窗口取决于**下一次正常刷新**
 * 何时发生，而不是它自己的 exp。
 *
 * @packageDocumentation
 */

import type { TokenKind } from './jwt-payload'

/** 各 kind 的 access TTL（秒）+ refresh TTL（秒）。 */
export interface TokenTtlConfig {
  access: Record<TokenKind, number>
  refresh: number
}

/** 见文件头的表。 */
export const DEFAULT_TTL: TokenTtlConfig = {
  access: {
    platform: 4 * 60 * 60,
    staff: 8 * 60 * 60,
    member: 7 * 24 * 60 * 60,
  },
  refresh: 30 * 24 * 60 * 60,
}

/** `AuthModule.forRoot({ ttl })` 的入参形状：逐项可覆盖。 */
export interface TokenTtlOverrides {
  access?: Partial<Record<TokenKind, number>>
  refresh?: number
}

/** 把用户覆盖合进默认值。 */
export function resolveTtl(overrides: TokenTtlOverrides | undefined): TokenTtlConfig {
  return {
    access: { ...DEFAULT_TTL.access, ...(overrides?.access ?? {}) },
    refresh: overrides?.refresh ?? DEFAULT_TTL.refresh,
  }
}
