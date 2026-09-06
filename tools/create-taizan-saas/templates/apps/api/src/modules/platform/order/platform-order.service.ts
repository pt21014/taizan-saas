/**
 * 平台侧套餐订单查询（T1-7）——**只读**。下单/支付回调/线下开单的写路径属于 T1-5
 * （`plan-order/` 模块），本文件不碰任何写操作。
 *
 * `PlanOrder` 是租户域表（有 `tenantId` 列），但平台后台要看**全量**订单，
 * 跨租户查询走 `RawPrismaService`——属于 `raw-reasons.ts` 里
 * `src/modules/platform/` 整目录的豁免。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode, normalizePage, type PageResult } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type { ListPlanOrderQueryDto } from './dto/order.dto'

/** 下发给平台后台的订单行。 */
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
  operatorId: string | null
  createdAt: string
}

type PlanOrderRow = NonNullable<Awaited<ReturnType<AppPrismaClient['planOrder']['findUnique']>>>

function toView(row: PlanOrderRow): PlanOrderView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    planId: row.planId,
    type: row.type,
    periods: row.periods,
    amountCents: row.amountCents,
    discountCents: row.discountCents,
    status: row.status,
    payChannel: row.payChannel,
    outTradeNo: row.outTradeNo,
    transactionId: row.transactionId,
    paidAt: row.paidAt?.toISOString() ?? null,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    expireBeforeAt: row.expireBeforeAt?.toISOString() ?? null,
    expireAfterAt: row.expireAfterAt?.toISOString() ?? null,
    operatorId: row.operatorId,
    createdAt: row.createdAt.toISOString(),
  }
}

@Injectable()
export class PlatformOrderService {
  constructor(
    // raw-reason: 平台后台——PlanOrder 虽是租户域表，但平台要看全量，跨租户查询。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
  ) {}

  async list(query: ListPlanOrderQueryDto): Promise<PageResult<PlanOrderView>> {
    const { page, pageSize } = normalizePage(query)
    const where = {
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    }

    // raw-reason: 平台后台——订单列表，跨租户查询 PlanOrder。
    const [rows, total] = await Promise.all([
      this.raw.client.planOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.raw.client.planOrder.count({ where }),
    ])
    return { items: rows.map(toView), total, page, pageSize }
  }

  async get(id: string): Promise<PlanOrderView> {
    // raw-reason: 平台后台——按 id 取订单，跨租户查询 PlanOrder。
    const row = await this.raw.client.planOrder.findUnique({ where: { id } })
    if (!row) throw new BizException(ErrorCode.BAD_REQUEST, '订单不存在')
    return toView(row)
  }
}
