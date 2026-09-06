/**
 * 平台侧审计查询（T1-7，**只读**）。
 *
 * - `list()` 查 `PlatformAuditLog`（平台域表，平台高危操作，无租户维度）。
 * - `listForTenant()` 查某个租户的 `AuditLog`（租户域表，平台后台要看**某一家店**的全量，
 *   跨租户按 id 精确定位，属于 raw 的第三类合法用途）。
 *
 * 两张表都走 `RawPrismaService`——属于 `raw-reasons.ts` 里 `src/modules/platform/`
 * 整目录的豁免。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { normalizePage, type PageResult } from '@taizan/contracts'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type { ListPlatformAuditLogQueryDto, ListTenantAuditLogQueryDto } from './dto/audit-log.dto'

/** 平台域审计行。 */
export interface PlatformAuditLogView {
  id: string
  targetTenantId: string | null
  actorType: string
  actorId: string
  actorName: string
  action: string
  targetType: string | null
  targetId: string | null
  before: unknown
  after: unknown
  ip: string
  traceId: string
  result: string
  createdAt: string
}

/** 租户域审计行。 */
export interface TenantAuditLogView {
  id: string
  tenantId: string
  actorType: string
  actorId: string
  actorName: string
  action: string
  targetType: string | null
  targetId: string | null
  before: unknown
  after: unknown
  ip: string
  traceId: string
  result: string
  createdAt: string
}

type PlatformAuditLogRow = Awaited<
  ReturnType<AppPrismaClient['platformAuditLog']['findMany']>
>[number]
type AuditLogRow = Awaited<ReturnType<AppPrismaClient['auditLog']['findMany']>>[number]

function toPlatformView(row: PlatformAuditLogRow): PlatformAuditLogView {
  return {
    id: row.id,
    targetTenantId: row.targetTenantId,
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: row.before,
    after: row.after,
    ip: row.ip,
    traceId: row.traceId,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
  }
}

function toTenantView(row: AuditLogRow): TenantAuditLogView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: row.before,
    after: row.after,
    ip: row.ip,
    traceId: row.traceId,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
  }
}

@Injectable()
export class PlatformAuditService {
  constructor(
    // raw-reason: 平台后台——PlatformAuditLog 是平台域表；AuditLog 虽是租户域表，
    // 但平台要跨租户按 id 精确查某一家店的全量审计。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
  ) {}

  async list(query: ListPlatformAuditLogQueryDto): Promise<PageResult<PlatformAuditLogView>> {
    const { page, pageSize } = normalizePage(query)
    const where = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.targetTenantId ? { targetTenantId: query.targetTenantId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    }

    // raw-reason: 平台后台——平台审计日志列表，PlatformAuditLog 无租户维度。
    const [rows, total] = await Promise.all([
      this.raw.client.platformAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.raw.client.platformAuditLog.count({ where }),
    ])
    return { items: rows.map(toPlatformView), total, page, pageSize }
  }

  async listForTenant(
    tenantId: string,
    query: ListTenantAuditLogQueryDto,
  ): Promise<PageResult<TenantAuditLogView>> {
    const { page, pageSize } = normalizePage(query)
    const where = {
      tenantId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    }

    // raw-reason: 平台后台——按租户 id 查它的全量 AuditLog，跨租户查询。
    const [rows, total] = await Promise.all([
      this.raw.client.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.raw.client.auditLog.count({ where }),
    ])
    return { items: rows.map(toTenantView), total, page, pageSize }
  }
}
