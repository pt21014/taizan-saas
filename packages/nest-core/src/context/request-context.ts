/**
 * 每请求上下文（蓝图 §4.1）。
 *
 * 这是整个框架的隐式参数总线：租户隔离扩展取 `tenantId`、审计取 `identity` 与 `ip`、
 * 日志取 `traceId`、限流取 `ip`。刻意**不**把它做成 Nest 的 REQUEST scoped provider——
 * 一旦有 request-scoped provider，整条依赖链都会变成每请求实例化，性能与心智负担都不划算，
 * 而且队列 job / cron tick 这些没有 HTTP 请求的场景根本拿不到。AsyncLocalStorage 两边都覆盖。
 */
export interface RequestContext {
  /** 本次执行的 traceId（26 位 ULID）。日志、响应头 `X-Trace-Id`、审计记录三处必须是同一个值。 */
  traceId: string
  /**
   * 上游 traceId。队列 job 与 cron tick 各开自己的 traceId，
   * 并把触发它的请求 traceId 记在这里，串起一条完整链路。
   */
  parentTraceId?: string
  /** 当前租户。平台面（`/api/platform`）与公共面（`/api/public`）没有租户，此处为 undefined。 */
  tenantId?: string
  /** 当前身份。未登录请求为 undefined。 */
  identity?: {
    kind: 'platform' | 'staff' | 'member'
    /** 主体 id：platform 是管理员 id，staff 是员工 id，member 是会员 id */
    id: string
    /** 账号 id（一号多店时，同一个账号可以对应多个租户下的 staff 记录） */
    accountId?: string
  }
  /**
   * 两个 IP 维度。
   * - `client`：真实客户端 IP，限流按人算、审计记录用它；
   * - `edge`：直连我们的那一跳（CDN 节点 / 网关），限流按入口算用它。
   *
   * 两个都记，是因为只记 client 时攻击者伪造 XFF 就能把限流打散，
   * 只记 edge 时同一个 CDN 节点后面的正常用户会互相牵连。
   */
  ip: { client: string; edge: string }
  /** 本次执行开始时间（`Date.now()`），用于算耗时。 */
  startedAt: number
}
