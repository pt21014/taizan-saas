/**
 * `/api/platform/orders` —— 套餐订单查询（T1-7，**只读**）。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Auth } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { ListPlanOrderQueryDto } from './dto/order.dto'
import { PlatformOrderService, type PlanOrderView } from './platform-order.service'

@ApiTags('platform/orders')
@Controller('api/platform/orders')
@Auth('platform')
export class PlatformOrderController {
  constructor(@Inject(PlatformOrderService) private readonly orders: PlatformOrderService) {}

  @Get()
  @ApiOperation({ summary: '订单列表（按租户/状态/时间筛选，分页）' })
  list(
    @Query(Validate(ListPlanOrderQueryDto)) query: ListPlanOrderQueryDto,
  ): Promise<PageResult<PlanOrderView>> {
    return this.orders.list(query)
  }

  @Get(':id')
  @ApiOperation({ summary: '订单详情' })
  get(@Param('id') id: string): Promise<PlanOrderView> {
    return this.orders.get(id)
  }
}
