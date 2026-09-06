/**
 * 框架基础表的租户域清单与平台域白名单。
 *
 * 这份清单决定「哪些框架表受租户隔离约束」。**漏一张 = 那张表静默跨租户泄漏**
 * （xiaodian 2026-08 的真实事故），所以它由 `schema.spec.ts` 与 `schema/` 双向比对，
 * 两个方向任一不一致就红：
 * - schema 里带 `tenantId` 却不在本清单 → 该表毫无隔离；
 * - 在本清单却 schema 里查无 `tenantId` 列 → 名字写错了，同样等于没隔离。
 *
 * 业务项目不要改这里，业务表在自己的 `apps/api/src/tenancy/tenant-models.ts` 里
 * `registry.register([...])`。
 */

import { createTenantModelRegistry, type TenantModelRegistry } from '@taizan/tenant-scope'
import type { TenantModelAllowlistEntry } from '@taizan/tenant-scope'

/**
 * 框架基础表里的**租户域**模型（全部带 `tenantId String` NOT NULL）。
 *
 * 与之相对，`Tenant` / `Plan` / `PlatformAdmin` / `StaffAccount` / `Permission` / `Menu` /
 * `RolePreset` / `Announcement` / `AnnouncementRead` / `PlatformSetting` /
 * `PlatformAuditLog` / `PlatformNotifyRecord` / `IdempotencyKey` / `JobDeadLetter` /
 * `CronRun` / `OutboxEvent` 是平台域，它们**根本没有 `tenantId` 列**，所以不需要白名单。
 */
export const BASE_TENANT_MODELS = [
  // 01-tenant
  'TenantVerification',
  'TenantCredential',
  // 02-plan
  'PlanOrder',
  'QuotaCounter',
  // 03-identity
  'Staff',
  'StaffInvite',
  'Member',
  // 04-rbac
  'Role',
  // 05-audit
  'AuditLog',
  // 08-notify
  'NotifyRecord',
] as const satisfies readonly string[]

/**
 * 「带 `tenantId` 列却刻意不隔离」的框架表白名单。
 *
 * **当前为空，而且这是设计目标而不是偷懒**（蓝图附录 #2：可空 tenantId 一律禁止、改成拆表，
 * 换来隔离名单零例外）。框架里凡是「平台共享 + 租户私有」的场景都拆成了两张表
 * （`RolePreset`/`Role`、`AuditLog`/`PlatformAuditLog`、`NotifyRecord`/`PlatformNotifyRecord`），
 * 凡是只需要记录来源租户的基础设施表都把列名改成了 `originTenantId` / `targetTenantId`
 * ——那不是归属列，也就不该被隔离校验器当成归属列。
 *
 * 万一将来真要往这里加一条，`reason` 必须写清「为什么这张表带 tenantId 却不隔离」，
 * 空理由会被 `verifySchema` 判为无效条目。
 */
export const BASE_PLATFORM_ALLOWLIST: readonly TenantModelAllowlistEntry[] = []

/**
 * 创建一个已经装好框架基础表的租户模型注册表。
 *
 * @returns 未冻结的注册表，业务项目继续 `register()` 自己的表后再 `freeze()`
 *
 * @example
 * ```ts
 * // apps/api/src/tenancy/tenant-models.ts
 * export const registry = createBaseRegistry()
 * registry.register(['Goods', 'GoodsSku'])
 * export const TENANT_MODELS = registry.freeze()
 * ```
 */
export function createBaseRegistry(): TenantModelRegistry {
  return createTenantModelRegistry(BASE_TENANT_MODELS)
}
