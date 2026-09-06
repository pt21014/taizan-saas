import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

/** `PlanOrder.status` 全集，与 `02-plan.prisma` 的 `PlanOrderStatus` 一一对应。 */
export const PLAN_ORDER_STATUSES = [
  'PENDING',
  'PAID',
  'FULFILLED',
  'CANCELLED',
  'REFUNDED',
] as const

/** 平台侧订单列表查询：只读，按租户 / 状态 / 时间筛选。 */
export class ListPlanOrderQueryDto {
  @ApiPropertyOptional({ type: Number, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ type: Number, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number

  @ApiPropertyOptional({ type: String, description: '按租户筛选' })
  @IsOptional()
  @IsString()
  @MaxLength(26)
  tenantId?: string

  @ApiPropertyOptional({ enum: PLAN_ORDER_STATUSES })
  @IsOptional()
  @IsIn(PLAN_ORDER_STATUSES as readonly string[])
  status?: (typeof PLAN_ORDER_STATUSES)[number]

  @ApiPropertyOptional({ type: String, description: '起始时间（含），ISO 字符串，按 createdAt 筛' })
  @IsOptional()
  @IsDateString()
  from?: string

  @ApiPropertyOptional({ type: String, description: '结束时间（含），ISO 字符串，按 createdAt 筛' })
  @IsOptional()
  @IsDateString()
  to?: string
}
