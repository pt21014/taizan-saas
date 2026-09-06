/**
 * 跨租户看板：租户数按状态、7 天新增、即将到期（7 天内）、收入汇总（T1-7）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **本文件（以及本目录下其它非 spec 源码）禁止出现 `findMany(`。**
 *
 * 看板是汇总数字，不是明细列表——`groupBy`/`count`/`aggregate` 能把「算总数」这件事
 * 留在数据库里做完，而 `findMany` 再在应用层 `.length`/`.reduce` 是把全表（或全租户/
 * 全订单）搬到 Node 进程里数一遍，租户或订单一多，这个接口就是那个「平台后台点一下
 * 就能打崩数据库」的按钮。`dashboard.no-findmany.spec.ts` 扫描本目录源码断言这一点，
 * 扫描器本身带哨兵（见那个文件），不会「扫不到东西就假通过」。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `Tenant` / `PlanOrder` 都是平台/租户域表，跨租户统计走 `RawPrismaService`——
 * 属于 `raw-reasons.ts` 里 `src/modules/platform/` 整目录的豁免。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { RawPrismaService } from '@taizan/nest-prisma'
import {
  addCalendarMonths,
  calendarDayOf,
  daysInMonth,
  DEFAULT_TIMEZONE,
  endOfCalendarDay,
  startOfCalendarDay,
} from '@taizan/billing-rules'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type { DashboardOverviewQueryDto } from './dto/dashboard.dto'

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 某个自然月的收入汇总。 */
export interface MonthlyRevenue {
  /** `YYYY-MM`。 */
  month: string
  amountCents: number
}

/** 跨租户看板。 */
export interface DashboardOverview {
  /** 租户数按状态分组。 */
  tenantCountsByStatus: Record<string, number>
  /** 近 7 天新增租户数。 */
  newTenants7d: number
  /** 未来 7 天内到期（`ACTIVE`/`TRIAL` 且 `planExpireAt` 落在窗口内）的租户数。 */
  expiringSoon7d: number
  /** 近 N 个自然月（含当月）的收入汇总，按 `PlanOrder.fulfilledAt` 落月、只算 `FULFILLED`。 */
  revenueByMonth: MonthlyRevenue[]
}

@Injectable()
export class DashboardService {
  constructor(
    // raw-reason: 平台后台——跨租户汇总统计，Tenant / PlanOrder 均为跨租户查询对象。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
  ) {}

  async overview(query: DashboardOverviewQueryDto): Promise<DashboardOverview> {
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS)
    const sevenDaysLater = new Date(now.getTime() + 7 * DAY_MS)

    const [byStatus, newTenants7d, expiringSoon7d, revenueByMonth] = await Promise.all([
      this.tenantCountsByStatus(),
      // raw-reason: 平台后台——近 7 天新增租户数，count 不拖全表。
      this.raw.client.tenant.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      // raw-reason: 平台后台——7 天内到期租户数，count 不拖全表。
      this.raw.client.tenant.count({
        where: {
          status: { in: ['ACTIVE', 'TRIAL'] },
          planExpireAt: { gte: now, lte: sevenDaysLater },
        },
      }),
      this.revenueByMonth(query.revenueMonths ?? 6, now),
    ])

    return {
      tenantCountsByStatus: byStatus,
      newTenants7d,
      expiringSoon7d,
      revenueByMonth,
    }
  }

  /** 租户数按状态分组：一次 `groupBy`，不是四次 `count`，也不是一次 `findMany` 再手动分组。 */
  private async tenantCountsByStatus(): Promise<Record<string, number>> {
    // raw-reason: 平台后台——按状态分组计数，groupBy 不拖全表。
    const grouped = await this.raw.client.tenant.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    const out: Record<string, number> = {}
    for (const g of grouped as Array<{ status: string; _count: { _all: number } }>) {
      out[g.status] = g._count._all
    }
    return out
  }

  /**
   * 近 `months` 个自然月（含当月）的收入汇总。
   *
   * 用 `@taizan/billing-rules` 的日历工具算每个月的 `[月初, 月末]`（按 `Asia/Shanghai`，
   * 与续期/到期判定同一个时区口径），对每个月各发一次 `aggregate({ _sum })`——
   * 是 `months` 次 `aggregate`，**不是一次 `findMany` 再在内存里按月分桶**。
   */
  private async revenueByMonth(months: number, now: Date): Promise<MonthlyRevenue[]> {
    const anchor = calendarDayOf(now, DEFAULT_TIMEZONE)
    const buckets = Array.from({ length: months }, (_, i) => {
      const first = addCalendarMonths({ ...anchor, day: 1 }, -(months - 1 - i))
      const last = { ...first, day: daysInMonth(first.year, first.month) }
      return {
        label: `${first.year}-${String(first.month).padStart(2, '0')}`,
        start: startOfCalendarDay(first, DEFAULT_TIMEZONE),
        end: endOfCalendarDay(last, DEFAULT_TIMEZONE),
      }
    })

    const sums = await Promise.all(
      buckets.map((b) =>
        // raw-reason: 平台后台——按月聚合已履约订单金额，aggregate 不拖全表。
        this.raw.client.planOrder.aggregate({
          where: { status: 'FULFILLED', fulfilledAt: { gte: b.start, lte: b.end } },
          _sum: { amountCents: true },
        }),
      ),
    )

    return buckets.map((b, i) => ({
      month: b.label,
      amountCents: sums[i]?._sum.amountCents ?? 0,
    }))
  }
}
