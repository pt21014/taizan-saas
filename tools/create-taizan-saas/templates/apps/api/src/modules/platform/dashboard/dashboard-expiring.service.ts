/**
 * 「即将到期的租户」明细列表（T3-4 任务书条目③）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **本文件是 `dashboard.no-findmany.spec.ts` 那条「本目录零 findMany」约束的唯一例外**
 * （白名单登记在那份 spec 文件里，连同这段理由一起）。
 *
 * `dashboard.service.ts` 的 `findMany` 禁令针对的是「汇总数字」类接口——那类接口只该
 * 回答「有多少」，`count`/`groupBy`/`aggregate` 能让数据库做完这件事，`findMany` 再在
 * 应用层数一遍等于把全表搬进 Node 进程。但这个接口回答的是另一个问题：「具体是哪几家、
 * 什么时候到期」——这**天然是明细列表**，不是汇总数字，`count` 回答不了它。
 *
 * 真正要守住的不变量不是「零 findMany」，而是「零全表扫描」：这里的 `findMany` 带
 * `skip`/`take`（分页），且 `where` 命中 `Tenant` 表在 `platform-tenant.service.ts`
 * 里已经在用的 `(status, planExpireAt)` 组合索引形态——一次查询只搬一页，不是全表。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { normalizePage, type PageResult } from '@taizan/contracts'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type { DashboardExpiringQueryDto } from './dto/dashboard.dto'

/** 一行「即将到期的租户」。 */
export interface ExpiringTenantView {
  id: string
  slug: string
  name: string
  planExpireAt: string
  /** 距到期还有几天（向上取整），已经过期（不该出现，但防御一下）时可能是 0 或负数。 */
  daysLeft: number
}

/** 一行 `Tenant`，只取这个接口用得到的列。 */
type TenantExpiringRow = {
  id: string
  slug: string
  name: string
  planExpireAt: Date | null
}

@Injectable()
export class DashboardExpiringService {
  constructor(
    // raw-reason: 平台后台——跨租户明细列表，Tenant 是平台/租户域表，属于第三类合法用途。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
  ) {}

  async list(query: DashboardExpiringQueryDto): Promise<PageResult<ExpiringTenantView>> {
    const { page, pageSize } = normalizePage(query)
    const days = query.days ?? 7
    const now = new Date()
    const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)

    const where = {
      status: { in: ['ACTIVE', 'TRIAL'] as ('ACTIVE' | 'TRIAL')[] },
      planExpireAt: { gte: now, lte: windowEnd },
    }

    // raw-reason: 平台后台——分页明细，带 take，不是全表 findMany。
    const [rows, total] = await Promise.all([
      this.raw.client.tenant.findMany({
        where,
        select: { id: true, slug: true, name: true, planExpireAt: true },
        orderBy: { planExpireAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      // raw-reason: 平台后台——count 配这次分页用，不拖全表。
      this.raw.client.tenant.count({ where }),
    ])

    return {
      items: rows.map((row) => toView(row, now)),
      total,
      page,
      pageSize,
    }
  }
}

function toView(row: TenantExpiringRow, now: Date): ExpiringTenantView {
  // where 子句已经保证 planExpireAt 非空（`gte: now`），这里的非空断言不会在运行时炸。
  const expireAt = row.planExpireAt as Date
  const daysLeft = Math.ceil((expireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    planExpireAt: expireAt.toISOString(),
    daysLeft,
  }
}
