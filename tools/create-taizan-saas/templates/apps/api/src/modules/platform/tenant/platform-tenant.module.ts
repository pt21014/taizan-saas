import { Module } from '@nestjs/common'

import { PlanOrderModule } from '../plan-order/plan-order.module'
import { PlatformTenantController } from './platform-tenant.controller'
import { PlatformTenantService } from './platform-tenant.service'

/**
 * `imports: [PlanOrderModule]`——续期（`PATCH :tenantId/renew`）不再自己改
 * `planExpireAt`，而是「下单 + 线下核销」两步走 `PlanOrderService` 的统一 `fulfill()`
 * （T1-5，蓝图 §4.6）。
 */
@Module({
  imports: [PlanOrderModule],
  controllers: [PlatformTenantController],
  providers: [PlatformTenantService],
})
export class PlatformTenantModule {}
