/**
 * 审计条目的共用类型（蓝图 §4.8）。
 *
 * 字段严格对齐 `packages/prisma-base/schema/05-audit.prisma` 的 `AuditLog` /
 * `PlatformAuditLog` / `ActorType` / `AuditResult`——这是唯一真源，改字段先改那份 schema。
 *
 * @packageDocumentation
 */

/** 操作者身份类型，对应 schema 里的 `ActorType` 枚举。 */
export type ActorType = 'PLATFORM_ADMIN' | 'STAFF' | 'MEMBER' | 'SYSTEM'

/** 审计结果，对应 schema 里的 `AuditResult` 枚举。 */
export type AuditOutcome = 'SUCCESS' | 'FAIL'

/**
 * 租户域审计条目，写入 `AuditLog`。
 *
 * 刻意没有 `tenantId` 字段：`AuditLog` 是 `@taizan/prisma-base` 登记过的租户域模型，
 * `AuditService.record()` 走 `PrismaService.tenant` 句柄时，租户隔离扩展会自动从当前
 * 请求上下文（或调用方传入的 `tx`）把 `tenantId` 拼进 `create` 的 `data` 里——手动传反而
 * 可能和上下文对不上被扩展的 `TENANT_ID_CONFLICT` 拦下来。真要跨上下文写审计（几乎不该
 * 发生），请自己 `runWithContext` 切进目标租户后再调用。
 */
export interface AuditEntry {
  /** 动作码，`module.action`，建议来自 `defineAuditActions()` 定义的常量。 */
  action: string
  actorType: ActorType
  /** 操作者 id：Staff.id / Member.id / PlatformAdmin.id；`SYSTEM` 时填任务名。 */
  actorId: string
  /** 操作者名字快照——人和账号都可能被删，日志得留得住能看懂的名字。 */
  actorName: string
  /** 被操作对象的类型名（业务实体名，自由文本，不是枚举）。 */
  targetType?: string
  targetId?: string
  /** 变更前快照，敏感字段应在传入前就已脱敏。 */
  before?: unknown
  /** 变更后快照 / 请求体，敏感字段应在传入前就已脱敏。 */
  after?: unknown
  /** 缺省取 `currentContext()?.ip.client`；取不到（例如 cron/队列）落空串。 */
  ip?: string
  /** 缺省取 `currentContext()?.traceId`；取不到就新生成一个 ULID，保证这一列永不为空。 */
  traceId?: string
  /** 缺省 `'SUCCESS'`。 */
  result?: AuditOutcome
}

/**
 * 平台域审计条目，写入 `PlatformAuditLog`。
 *
 * `targetTenantId` 是「这次操作打到了哪家店」，**不是**归属列，`PlatformAuditLog` 本身
 * 不受租户隔离约束（它压根没有 `tenantId` 列）。`actorType` 缺省 `'PLATFORM_ADMIN'`，
 * 与 schema 的列默认值保持一致，但由服务层显式写死而不是依赖数据库默认值——测试用的
 * 替身客户端不模拟数据库默认值，服务层自己兜底才能保证行为在真库/替身下一致。
 */
export interface PlatformAuditEntry extends Omit<AuditEntry, 'actorType'> {
  actorType?: ActorType
  targetTenantId?: string
}

/**
 * `@Audit({ captureBefore: true })` 要求「controller 所在 provider」实现的接口：
 * 按目标 id 拍一张「当前状态」快照。`AuditInterceptor` 会在处理器执行前后各调用一次，
 * 分别落进审计记录的 `before` / `after`。
 */
export interface AuditSnapshot {
  snapshotForAudit(targetId: string): Promise<unknown>
}
