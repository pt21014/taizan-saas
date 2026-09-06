/**
 * `AuditService`：审计写入（蓝图 §4.8）。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { currentContext } from '@taizan/nest-core'
import { callOperation, PrismaService, type PrismaClientLike } from '@taizan/nest-prisma'
import { ulid } from '@taizan/contracts'
import type { AuditEntry, PlatformAuditEntry } from './types'

function resolveIp(explicit?: string): string {
  if (explicit !== undefined) return explicit
  return currentContext()?.ip.client ?? ''
}

/**
 * traceId 这一列不允许为空（它是排查链路的锚点），缺省顺序：显式传入 → 当前上下文 →
 * 兜底新生成一个 ULID。三层兜底才能保证 cron/队列里「上下文有 traceId 但调用方偷懒
 * 没传」和「压根不在任何上下文里」两种情况都落得到一个可用值。
 */
function resolveTraceId(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  return currentContext()?.traceId ?? ulid()
}

function toAuditLogData(entry: AuditEntry): Record<string, unknown> {
  return {
    actorType: entry.actorType,
    actorId: entry.actorId,
    actorName: entry.actorName,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: resolveIp(entry.ip),
    traceId: resolveTraceId(entry.traceId),
    result: entry.result ?? 'SUCCESS',
  }
}

function toPlatformAuditLogData(entry: PlatformAuditEntry): Record<string, unknown> {
  return {
    // 缺省 PLATFORM_ADMIN：与 schema 的列默认值一致，但由这里显式写死而不是指望数据库
    // 默认值——测试用的替身客户端不模拟数据库默认值，服务层自己兜底才能保证行为一致。
    actorType: entry.actorType ?? 'PLATFORM_ADMIN',
    actorId: entry.actorId,
    actorName: entry.actorName,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    targetTenantId: entry.targetTenantId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: resolveIp(entry.ip),
    traceId: resolveTraceId(entry.traceId),
    result: entry.result ?? 'SUCCESS',
  }
}

/**
 * 审计写入服务。
 *
 * `AuditInterceptor` 是主要调用方（HTTP 请求自动审计），本服务同时暴露给事务内、
 * cron、队列等非 HTTP 场景手动补充审计记录。
 *
 * **本服务不吞异常**——`record()` / `recordPlatform()` 写失败会原样往外抛：
 * - 传了 `tx` 参与调用方事务时，失败应该让整个事务回滚，吞掉反而是把「审计其实
 *   没记上」悄悄放过去，比事务失败更糟；
 * - `AuditInterceptor` 调用时由它自己 catch，记 `HealthCounters.auditFailures` 并打
 *   error 日志，不影响主响应（这是蓝图 §4.8「审计写失败不能吞」的落地位置，
 *   见 `audit.interceptor.ts` 文件头）。
 *
 * 两张表分工：
 * - `record()` 写租户域 `AuditLog`，走 `prisma.tenant` 句柄——`tenantId` 由租户隔离
 *   扩展从当前上下文自动注入，本服务不接受调用方显式传 `tenantId`；
 * - `recordPlatform()` 写平台域 `PlatformAuditLog`，走 `prisma.raw` 句柄——该表不受
 *   租户隔离约束，这是 `@taizan/nest-prisma` 文档里「平台后台」这一处合法 raw 用途。
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 写一条租户域 `AuditLog`。
   *
   * @param entry - 见 {@link AuditEntry}
   * @param tx - 可选：调用方事务的客户端（例如 `prisma.$transaction` 回调里拿到的
   *   `tx`）。传了就用它写，让这次审计记录参与那个事务；不传则用
   *   `PrismaService.tenant`（默认场景，也参与当前请求隐式的自动提交）。
   */
  async record(entry: AuditEntry, tx?: PrismaClientLike): Promise<void> {
    const client = tx ?? (this.prisma.tenant as PrismaClientLike)
    await callOperation(client, 'auditLog', 'create', { data: toAuditLogData(entry) })
  }

  /**
   * 写一条平台域 `PlatformAuditLog`。
   *
   * @param entry - 见 {@link PlatformAuditEntry}
   * @param tx - 可选：调用方事务的客户端，语义同 {@link AuditService.record}。
   */
  // raw-reason: PlatformAuditLog 是平台域表，没有 tenantId 列，写入属于 @taizan/nest-prisma
  // 文档里「平台后台」这一处合法 raw 用途，不经过（也不需要）租户隔离。
  async recordPlatform(entry: PlatformAuditEntry, tx?: PrismaClientLike): Promise<void> {
    const client = tx ?? (this.prisma.raw as PrismaClientLike)
    await callOperation(client, 'platformAuditLog', 'create', {
      data: toPlatformAuditLogData(entry),
    })
  }
}
