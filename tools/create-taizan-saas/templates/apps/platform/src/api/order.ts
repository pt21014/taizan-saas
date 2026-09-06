import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 订单状态全集，对齐 `PlanOrder.status`。 */
export const PLAN_ORDER_STATUSES = [
  'PENDING',
  'PAID',
  'FULFILLED',
  'CANCELLED',
  'REFUNDED',
] as const

export const PLAN_ORDER_STATUS_TAGS: Record<string, StatusTagConfig> = {
  PENDING: { text: '待支付', color: 'default' },
  PAID: { text: '已支付', color: 'processing' },
  FULFILLED: { text: '已履约', color: 'success' },
  CANCELLED: { text: '已取消', color: 'default' },
  REFUNDED: { text: '已退款', color: 'error' },
}

/** `GET /api/platform/orders` 的一行。 */
export interface PlanOrderView {
  id: string
  tenantId: string
  planId: string
  type: string
  periods: number
  amountCents: number
  discountCents: number
  status: string
  payChannel: string | null
  outTradeNo: string
  transactionId: string | null
  paidAt: string | null
  fulfilledAt: string | null
  expireBeforeAt: string | null
  expireAfterAt: string | null
  createdAt: string
}

export interface CreatePlanOrderInput {
  tenantId: string
  planId: string
  periods: number
  channel?: string
}

/**
 * 订单模块的接口层。**读写分属两个后端控制器**（`GET /api/platform/orders` 只读，
 * `POST /api/platform/plan-orders` 系列只写，两者操作同一张 `PlanOrder` 表/同一批 id，
 * 见 `plan-order.controller.ts` 头部注释——刻意不让同一批数据出现两套只读接口）。
 * 前端这里合成一个模块，业务上就是「订单」这一件事。
 */
export function useOrderApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) =>
      req.get<PageResult<PlanOrderView>>('/api/platform/orders', query),
    get: (id: string) => req.get<PlanOrderView>(`/api/platform/orders/${id}`),
    create: (values: CreatePlanOrderInput) =>
      req.post<PlanOrderView>('/api/platform/plan-orders', {
        ...values,
        channel: values.channel ?? 'OFFLINE',
      }),
    markPaid: (id: string) =>
      req.post<{ order: PlanOrderView }>(`/api/platform/plan-orders/${id}/mark-paid`),
    refund: (id: string, reason: string) =>
      req.post<{ order: PlanOrderView }>(`/api/platform/plan-orders/${id}/refund`, { reason }),
  }
}
