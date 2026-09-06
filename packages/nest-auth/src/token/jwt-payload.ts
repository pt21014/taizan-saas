/**
 * 三套身份的 token 载荷（蓝图 §4.3）。
 *
 * @packageDocumentation
 */

import { ErrorCode } from '@taizan/contracts'

/** 三套互不通用的身份。 */
export type TokenKind = 'platform' | 'staff' | 'member'

/** 全部 kind 的运行时清单（`@Auth()` 的校验、遍历三套密钥都要用）。 */
export const TOKEN_KINDS: readonly TokenKind[] = ['platform', 'staff', 'member'] as const

/** 是不是合法的 kind（从外部数据收窄用）。 */
export function isTokenKind(value: unknown): value is TokenKind {
  return typeof value === 'string' && (TOKEN_KINDS as readonly string[]).includes(value)
}

/**
 * access token 的载荷。
 *
 * ## 为什么 `kind` 既在密钥里体现、又要写进 payload
 *
 * 三套密钥各不相同，理论上拿 member 密钥签的 token 用 staff 密钥验签本来就过不了。
 * 但**部署事故会让这条防线消失**：有人图省事把三个 env 填成同一个值，
 * 或者密钥轮换脚本写错把三套刷成一套——那一刻 member token 就能冒充 staff。
 * payload 里再存一份 `kind` 并在 `verify` 里逐字比对，是这条防线的第二道；
 * 两道同时失效才会出事。`checkJwtSecretsDistinct`（nest-core 的 env 交叉校验）是第三道。
 *
 * ## 为什么不放 roleIds
 *
 * 放了就会有人用。staff 的角色**每请求现查库**并覆盖 token（蓝图 §4.3 关键不变量），
 * token 里那份必然是过期数据；不放进来，误用的可能性就是零。
 */
export interface TokenPayload {
  /** 身份类型。与签名密钥必须对得上，见上面的注释。 */
  kind: TokenKind
  /** 主体 id：platform 是 `PlatformAdmin.id`，staff 是 `Staff.id`，member 是 `Member.id`。 */
  sub: string
  /** 本次会话的唯一 id。吊销以它为粒度（改密全撤 / 踢最旧端）。 */
  jti: string
  /**
   * 当前店铺。staff / member 必有，platform 恒为 undefined。
   *
   * **这是租户解析链里优先级最高、且不可被任何请求参数覆盖的来源**（蓝图 §4.1）。
   * staff token 一次只绑一家店，换店必须重签（`AuthFlowService.switchTenant`）。
   */
  tenantId?: string
  /** staff 专有：`StaffAccount.id`。一号多店时同一个 accountId 对应多个租户下的 Staff。 */
  accountId?: string
  /** 载荷版本号。以后加字段时靠它区分老 token，避免上线瞬间全员被踢。 */
  ver: number
}

/** 当前签发的载荷版本。 */
export const TOKEN_PAYLOAD_VERSION = 1

/** {@link TokenService.sign} 的入参：`kind` 与 `jti` 由服务自己填。 */
export type SignablePayload = Omit<TokenPayload, 'kind' | 'jti'> & {
  /** 可选地指定 jti（换店重签时想复用同一条会话记录才需要），不传则自动生成 ULID。 */
  jti?: string
}

/** refresh token 的载荷。刻意与 access 分开：它只用来换新 token，不能拿去访问业务接口。 */
export interface RefreshPayload {
  kind: TokenKind
  sub: string
  /** refresh 自身的 id，同时是 Redis 里那把 key 的最后一段。 */
  rid: string
  tenantId?: string
  accountId?: string
  ver: number
  /** 固定 `'refresh'`。`GlobalAuthGuard` 见到它直接拒——防止 refresh 当 access 用。 */
  typ: 'refresh'
}

/** 认证相关的三个错误码，集中在这里，免得每个文件各写各的字面量。 */
export const AUTH_ERRORS = {
  /** 1140100 未登录 */
  UNAUTHENTICATED: ErrorCode.UNAUTHENTICATED,
  /** 1140101 登录已过期 */
  TOKEN_EXPIRED: ErrorCode.TOKEN_EXPIRED,
  /** 1140102 凭证类型不符 */
  KIND_MISMATCH: ErrorCode.TOKEN_KIND_MISMATCH,
} as const
