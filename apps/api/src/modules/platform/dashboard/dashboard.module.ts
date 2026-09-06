import { Module } from '@nestjs/common'

import { DashboardExpiringService } from './dashboard-expiring.service'
import { DashboardController } from './dashboard.controller'
import { DashboardService } from './dashboard.service'

@Module({
  controllers: [DashboardController],
  providers: [DashboardService, DashboardExpiringService],
})
export class DashboardModule {}
