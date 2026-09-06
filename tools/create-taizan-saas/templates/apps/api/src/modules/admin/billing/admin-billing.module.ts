import { Module } from '@nestjs/common'

import { PlanOrderModule } from '../../platform/plan-order/plan-order.module'
import { AdminBillingController } from './admin-billing.controller'
import { AdminBillingService } from './admin-billing.service'

/**
 * 商家侧账单面（`/api/admin/billing`）。
 *
 * 不 `imports: [BillingModule]`——`@taizan/nest-billing` 是 `@Global()` 的，
 * `PLATFORM_GATEWAY` 与 `QuotaService` 直接注入即可。
 */
@Module({
  // `PlanOrderModule` 是商家自助下单唯一的落库出口——兑现路径只能有一条（蓝图 §4.6），
  // 所以商家侧 import 平台侧那个 service，而不是在这边再写一份。
  // `PaymentService` 不用 import：`PaymentModule` 是 `@Global()` 的。
  imports: [PlanOrderModule],
  controllers: [AdminBillingController],
  providers: [AdminBillingService],
})
export class AdminBillingModule {}
