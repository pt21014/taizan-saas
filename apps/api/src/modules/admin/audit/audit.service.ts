/**
 * 商家侧的操作日志查询（T1-9，**只读**）。
 *
 * ## 为什么这一层薄成这样
 *
 * `AuditLog` 是【租户域】表，`prisma.tenant` 的隔离扩展会把租户条件 `AND` 进每次查询，
 * 调用方覆盖不掉。也就是说「商家只能看自己家的日志」这件事在这里**一行代码都不用写**
 * ——这正是隔离扩展存在的意义。平台侧那份（`platform/audit/platform-audit.service.ts`）
 * 反而要显式写 `where.tenantId`，因为它走 raw、要跨租户按 id 定位。
 *
 * ## `@DataScope` 为什么不适用于审计
 *
 * 数据范围（`ALL` / `SUB_TREE` / `SELF` / `CUSTOM`）翻译出来的是一段按**归属列**收窄的
 * `where` 片段，前提是那张表上有一列表示「这条数据是谁的」。`AuditLog` 上确实有
 * `actorId`，但它是「**谁干的**」而不是「这条数据属于谁」——按它收窄的语义会变成
 * 「只能看自己干过的事」，而那恰恰让审计失去意义：审计的读者是管理者，他要看的
 * 就是别人干了什么。
 *
 * 所以这条路由**只挂 `@RequirePermission('audit:list')`，不挂 `@DataScope`**：
 * 「能不能看审计」是一个是非题，由权限点回答；没有中间档。真需要「只让店长看
 * 本部门的操作」时，那要引入一列真正的归属维度（比如 `AuditLog.deptId`），
 * 在 schema 层面解决，而不是把 `actorId` 当归属列凑合。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { normalizePage, type PageResult } from '@taizan/contracts'
import { PrismaService } from '@taizan/nest-prisma'
import type { AuditLog, Prisma } from '@prisma/client'

import type { AppPrismaService } from '../../../common/prisma.types'
import type { ListAuditLogQueryDto } from './dto/audit.dto'

/** 下发给前端的一行操作日志。 */
export interface AuditLogView {
  id: string
  actorType: string
  actorId: string
  /** 操作者名字**快照**：人删了、改名了，日志上仍然是当时那个名字。 */
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

function toView(row: AuditLog): AuditLogView {
  return {
    id: row.id,
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

/** `action` 精确 与 `module` 前缀 二选一，精确优先。见调用处的注释。 */
function actionCondition(query: ListAuditLogQueryDto): Pick<Prisma.AuditLogWhereInput, 'action'> {
  if (query.action) return { action: query.action }
  if (query.module) return { action: { startsWith: `${query.module}.` } }
  return {}
}

@Injectable()
export class AdminAuditService {
  constructor(@Inject(PrismaService) private readonly prisma: AppPrismaService) {}

  async list(query: ListAuditLogQueryDto): Promise<PageResult<AuditLogView>> {
    const { page, pageSize } = normalizePage(query)

    const where: Prisma.AuditLogWhereInput = {
      // `action`（精确）与 `module`（前缀）落在同一列上，所以**只能二选一**：
      // 两个都写进对象字面量的话后者会静默覆盖前者，而调用方看不出来。
      // 精确优先——传了完整动作码就说明他知道自己要什么。
      // 动作码格式定死 `module.action`（`defineAuditActions` 在加载期校验），
      // 所以「按模块筛」就是一次前缀匹配，不需要额外存一列。
      ...actionCondition(query),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    }

    const [rows, total] = await Promise.all([
      this.prisma.tenant.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.auditLog.count({ where }),
    ])

    return { items: rows.map(toView), total, page, pageSize }
  }
}
