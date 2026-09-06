import { Module } from '@nestjs/common'

import { PlanOrderPaymentHandler } from './plan-order-payment.handler'
import { PlanOrderController } from './plan-order.controller'
import { PlanOrderService } from './plan-order.service'

/**
 * 平台收费闭环（T1-5）。
 *
 * `PlanOrderPaymentHandler` 只要出现在 `providers` 里就够了——`@taizan/nest-payment`
 * 的 `PaymentHandlerRegistry` 用 `DiscoveryService` 扫全容器找 `@PaymentHandler`，
 * 不需要在 `PaymentModule.forRoot()` 里再登记一遍。忘了放进 providers 的表现是
 * 「回调进来找不到处理器，控制器打一条 error 然后**正常应答**」——钱到账、权益没发、
 * 渠道那边一切正常，只有日志里有一行。启动日志的
 * 「outTradeNo 前缀 [PLAN]」就是这件事的自检。
 *
 * `exports: [PlanOrderService]`：商家自助下单（`/api/admin/billing/orders`）复用它。
 * 兑现路径只能有一条，所以商家侧不另建一个 service，而是 import 这个模块。
 */
@Module({
  controllers: [PlanOrderController],
  providers: [PlanOrderService, PlanOrderPaymentHandler],
  exports: [PlanOrderService],
})
export class PlanOrderModule {}
