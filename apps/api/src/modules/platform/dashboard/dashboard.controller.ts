/**
 * `/api/platform/dashboard` —— 跨租户看板（T1-7，只读，全部汇总查询）。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Auth } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { DashboardExpiringService, type ExpiringTenantView } from './dashboard-expiring.service'
import { DashboardService, type DashboardOverview } from './dashboard.service'
import { DashboardExpiringQueryDto, DashboardOverviewQueryDto } from './dto/dashboard.dto'

@ApiTags('platform/dashboard')
@Controller('api/platform/dashboard')
@Auth('platform')
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboard: DashboardService,
    @Inject(DashboardExpiringService) private readonly expiring: DashboardExpiringService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: '跨租户看板：租户数按状态 / 7 天新增 / 即将到期 / 月度收入' })
  overview(
    @Query(Validate(DashboardOverviewQueryDto)) query: DashboardOverviewQueryDto,
  ): Promise<DashboardOverview> {
    return this.dashboard.overview(query)
  }

  @Get('expiring')
  @ApiOperation({
    summary: '即将到期租户明细（slug/name/planExpireAt/daysLeft），分页，替代前端拉全量二次过滤',
  })
  expiringList(
    @Query(Validate(DashboardExpiringQueryDto)) query: DashboardExpiringQueryDto,
  ): Promise<PageResult<ExpiringTenantView>> {
    return this.expiring.list(query)
  }
}
