import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'

/** 看板查询参数：目前只有收入汇总要看几个月。 */
export class DashboardOverviewQueryDto {
  @ApiPropertyOptional({ type: Number, description: '收入汇总回溯几个月（含当月）', default: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  revenueMonths?: number
}

/** 「即将到期租户」明细查询：T3-4，替代前端原来拉一页 100 条自己按到期日二次过滤那条弯路。 */
export class DashboardExpiringQueryDto {
  @ApiPropertyOptional({ type: Number, description: '未来几天内到期，默认 7', default: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number

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
}
