import type { CrudListQuery } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 一档配额用量（对齐 `AdminBillingService.overview()` 的 `BillingQuotaView`）。 */
export interface BillingQuota {
  kind: string
  used: number
  limit: number | null
  remaining: number | null
}

/** `GET /api/admin/billing`（对齐 `BillingOverview`）。 */
export interface BillingOverview {
  planCode: string | null
  planName: string | null
  planExpireAt: string | null
  daysLeft: number | null
  phase: string
  readonly: boolean
  features: string[] | null
  quotas: BillingQuota[]
}

/** 可购套餐（对齐 `PurchasablePlanView`）。 */
export interface PurchasablePlan {
  id: string
  code: string
  name: string
  firstPriceCents: number
  renewPriceCents: number
  periodMonths: number
  trafficMb: number
  quotas: Record<string, number | null>
  features: string[] | null
}

/** 账单里的一行（对齐 `PlanOrderBillView`）。 */
export interface PlanOrderBill {
  id: string
  planId: string
  type: string
  periods: number
  amountCents: number
  status: string
  payChannel: string | null
  outTradeNo: string
  paidAt: string | null
  fulfilledAt: string | null
  expireAfterAt: string | null
  createdAt: string
}

/** 下单入参（对齐 `CreateSelfPlanOrderDto`）。 */
export interface CreateOrderInput {
  planId: string
  periods: number
  openId?: string
}

/** 下单结果：订单 + 原样透传的支付参数（对齐 `CreateSelfOrderResult`）。 */
export interface CreateOrderResult {
  order: PlanOrderBill
  payParams: Record<string, unknown>
  prepayRef?: string
}

/**
 * 账单模块的接口层：对齐 `AdminBillingController` 的四条真实路由。
 * 不是标准的「五函数 CRUD」形状——这个模块本身就不是一个可增删的资源，
 * `overview`/`plans`/`orders`/`createOrder` 分别对应后端那四条 GET/POST。
 */
export function useBillingApi() {
  const req = useSession((s) => s.request)
  return {
    overview: () => req.get<BillingOverview>('/api/admin/billing'),
    plans: () => req.get<PurchasablePlan[]>('/api/admin/billing/plans'),
    orders: (query: CrudListQuery) =>
      req.get<PageResult<PlanOrderBill>>('/api/admin/billing/orders', query),
    createOrder: (values: CreateOrderInput) =>
      req.post<CreateOrderResult>('/api/admin/billing/orders', values),
  }
}
