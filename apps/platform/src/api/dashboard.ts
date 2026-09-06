import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

export interface MonthlyRevenue {
  /** `YYYY-MM` */
  month: string
  amountCents: number
}

/** `GET /api/platform/dashboard/overview` 的响应。 */
export interface DashboardOverview {
  tenantCountsByStatus: Record<string, number>
  newTenants7d: number
  expiringSoon7d: number
  revenueByMonth: MonthlyRevenue[]
}

/** `GET /api/platform/dashboard/expiring` 的一行——对齐后端 `ExpiringTenantView`。 */
export interface ExpiringTenantView {
  id: string
  slug: string
  name: string
  planExpireAt: string
  daysLeft: number
}

export function useDashboardApi() {
  const req = useSession((s) => s.request)
  return {
    overview: (revenueMonths = 6) =>
      req.get<DashboardOverview>('/api/platform/dashboard/overview', { revenueMonths }),
    /**
     * 即将到期租户明细，服务端已经按 `days` 过滤 + 分页——不再需要像过去那样拉一页
     * `ACTIVE`/`TRIAL` 租户回来自己按 `planExpireAt` 二次过滤（那条路子在租户数超过
     * 一页时会漏数据，见 `apps/api/.../dashboard-expiring.service.ts` 头部注释）。
     */
    expiring: (days = 7, page = 1, pageSize = 20) =>
      req.get<PageResult<ExpiringTenantView>>('/api/platform/dashboard/expiring', {
        days,
        page,
        pageSize,
      }),
  }
}
