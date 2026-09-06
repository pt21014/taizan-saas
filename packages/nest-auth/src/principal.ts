/**
 * 认证通过后挂在 `req.principal` 上的主体对象。
 *
 * @packageDocumentation
 */

import type { TokenKind } from './token/jwt-payload'

/** `Staff.status` 的三档（与 `03-identity.prisma` 的 `StaffStatus` 一一对应）。 */
export type StaffStatus = 'ACTIVE' | 'DISABLED' | 'LEFT'

/** `Staff.dataScope` 的四档（与 `03-identity.prisma` 的 `DataScope` 一一对应）。 */
export type DataScope = 'ALL' | 'SUB_TREE' | 'SELF' | 'CUSTOM'

/**
 * 当前请求的登录主体。
 *
 * ## 为什么 staff 的字段不是从 token 里抄的
 *
 * `roleIds` / `dataScope` / `isOwner` 三个字段**一律来自数据库**（`MembershipProvider`
 * 每请求现查），token 里那份即使存在也被无条件丢弃（蓝图 §4.3 关键不变量）。
 * 理由很直接：token 活 8 小时，而「把某人踢出角色」这件事必须在秒级生效——
 * 用 token 里的副本意味着一个被降权的人还能用旧权限干 8 小时的活。
 *
 * `PermissionsGuard`（T1-2）、`DataScopeInterceptor`（T1-3）都从这里取值，
 * 它们看不到 token 原文，所以想「偷懒用 token 里的」在类型上就做不到。
 */
export interface AuthPrincipal {
  kind: TokenKind
  /** token 的 `sub`。platform 是 `PlatformAdmin.id`，staff 是 `Staff.id`，member 是 `Member.id`。 */
  id: string
  /** 本次会话 id，登出/踢端以它为粒度。 */
  jti: string
  /** 当前店铺。staff / member 必有，platform 恒为 undefined。 */
  tenantId?: string
  /** staff 专有：`StaffAccount.id`。 */
  accountId?: string

  // ── 以下三个字段只有 staff 有，且**只来自数据库** ──────────────────────
  /** 本租户内的角色 id 列表。 */
  roleIds?: string[]
  /** 数据权限范围。 */
  dataScope?: DataScope
  /** 店主标记。权限判定里恒为全量，且不可被移除。 */
  isOwner?: boolean
}

/** 挂了主体的 express 请求（避免每个用点都写一遍这个交叉类型）。 */
export interface RequestWithPrincipal {
  principal?: AuthPrincipal
  headers: Record<string, string | string[] | undefined>
  path?: string
  originalUrl?: string
  url?: string
  hostname?: string
}
