/**
 * `/api/platform/plan-orders` —— 平台侧套餐订单的**写**入口（T1-5）。
 *
 * 读在 T1-7 的 `/api/platform/orders`（`PlatformOrderController`），本文件一条
 * `GET` 都不加：同一批数据两个只读接口，前端迟早会挑一个用、另一个慢慢腐烂，
 * 而腐烂的那个上面的筛选条件会和真正在用的那个悄悄走偏。
 *
 * 三条路由对应蓝图 §4.6 状态机上的三条边，一条不多：
 *
 * ```
 * POST /api/platform/plan-orders             → [PENDING]      运营代下单
 * POST /api/platform/plan-orders/:id/mark-paid → [FULFILLED]  线下核销（走同一个 fulfill）
 * POST /api/platform/plan-orders/:id/refund    → [REFUNDED]   退款回退
 * ```
 *
 * `@Audit` 挂在「标记已付」与「退款」上：这两个是**平台运营手动改变商家权益**的高危
 * 操作，`PlatformAuditLog` 要记下是谁点的。下单本身不改权益，审计由服务层统一记。
 *
 * @packageDocumentation
 */

import { Body, Controller, Inject, Param, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Audit, AUDIT_ACTIONS } from '@taizan/nest-audit'
import { Auth, CurrentUser, type AuthPrincipal } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { CreatePlanOrderDto, RefundPlanOrderDto } from './dto/plan-order.dto'
import {
  PlanOrderService,
  type FulfillPlanOrderResult,
  type PlanOrderRow,
  type RefundPlanOrderResult,
} from './plan-order.service'

@ApiTags('platform/plan-orders')
@Controller('api/platform/plan-orders')
@Auth('platform')
export class PlanOrderController {
  constructor(@Inject(PlanOrderService) private readonly orders: PlanOrderService) {}

  @Post()
  @ApiOperation({ summary: '运营代下单（落一张 PENDING，不动权益）' })
  create(
    @Body(Validate(CreatePlanOrderDto)) dto: CreatePlanOrderDto,
    @CurrentUser() admin: AuthPrincipal,
  ): Promise<PlanOrderRow> {
    return this.orders.create({
      tenantId: dto.tenantId,
      planId: dto.planId,
      periods: dto.periods,
      channel: dto.channel ?? 'OFFLINE',
      operatorId: admin.id,
    })
  }

  /**
   * 线下打款到账后的手工核销。
   *
   * 它和在线支付回调**调的是同一个 `fulfill()`**（蓝图 §4.6 点名，
   * `test/arch/plan-order-fulfill.spec.ts` 扫源码盯着）。这里之所以只有一行，
   * 正是那条约束想要的样子——一旦有人在这个方法里开始写 `planExpireAt`，
   * 那条 spec 立刻红。
   */
  @Post(':id/mark-paid')
  @ApiOperation({ summary: '线下标记已付（与支付回调走同一个 fulfill 事务）' })
  @Audit({ action: AUDIT_ACTIONS.PLAN_ORDER_MARK_PAID, targetType: 'PlanOrder' })
  markPaid(
    @Param('id') id: string,
    @CurrentUser() admin: AuthPrincipal,
  ): Promise<FulfillPlanOrderResult> {
    return this.orders.markPaidOffline(id, admin.id)
  }

  @Post(':id/refund')
  @ApiOperation({ summary: '退款并把到期日回退到 expireBeforeAt（续过费的交人工）' })
  @Audit({ action: AUDIT_ACTIONS.PLAN_ORDER_REFUND, targetType: 'PlanOrder' })
  refund(
    @Param('id') id: string,
    @Body(Validate(RefundPlanOrderDto)) dto: RefundPlanOrderDto,
    @CurrentUser() admin: AuthPrincipal,
  ): Promise<RefundPlanOrderResult> {
    return this.orders.refund(id, admin.id, dto.reason)
  }
}
