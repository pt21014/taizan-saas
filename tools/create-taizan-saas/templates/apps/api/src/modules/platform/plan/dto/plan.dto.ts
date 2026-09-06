import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

import { PLAN_STATUSES } from '../plan.rules'

/**
 * 新建套餐。
 *
 * `quotas` 是**必填**的一份完整配额表（三态：`null` 不限 / `0` 禁用 / 正整数上限，
 * key 缺省按不限处理，见 `plan.rules.ts` 文件头）；`features` **可选**，
 * 不传时落 `null`（全部可用）——这与"传了空数组"是两种不同的库内状态。
 */
export class CreatePlanDto {
  @ApiProperty({
    type: String,
    description: '稳定标识，小写字母开头的 kebab-case',
    example: 'gold',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  code!: string

  @ApiProperty({ type: String, description: '套餐名', example: '黄金版' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string

  @ApiProperty({ type: Number, description: '首开价（分）' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  firstPriceCents!: number

  @ApiProperty({ type: Number, description: '续费价（分）' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  renewPriceCents!: number

  @ApiProperty({ type: Number, description: '一个计费周期的月数' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  periodMonths!: number

  @ApiProperty({
    type: Object,
    description:
      '配额表，key 见 QuotaKind（STAFF/STORE/MEMBER/STORAGE_MB/TRAFFIC_MB/CUSTOM）。' +
      'null=不限，0=禁用，正整数=上限；key 缺省按不限处理',
    example: { STAFF: 3, TRAFFIC_MB: 0, MEMBER: null },
  })
  @IsObject()
  quotas!: Record<string, number | null>

  @ApiPropertyOptional({
    type: [String],
    description: '功能白名单；不传（或未来显式传 null）= 全部可用，[] = 一个都不给',
    nullable: true,
  })
  @IsOptional()
  features?: string[] | null

  @ApiProperty({ type: [String], description: '允许接入的端，如 ["admin","client","app"]' })
  @IsArray()
  @IsString({ each: true })
  appKeys!: string[]

  @ApiPropertyOptional({
    type: Number,
    description: '每月流量额度（MB），0=不单独售卖流量',
    default: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  trafficMb?: number

  @ApiPropertyOptional({ type: Number, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number
}

/**
 * 修改套餐。全部字段可选，只改传了的；`quotas` 传对象时按 key 合并（未提到的 key 不动），
 * `features` 传 `null` 时显式清空为「全部可用」，传数组时整体覆盖，两者都不传就不动。
 */
export class UpdatePlanDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  code?: string

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  firstPriceCents?: number

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  renewPriceCents?: number

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  periodMonths?: number

  @ApiPropertyOptional({
    type: Object,
    description: '按 key 合并进现有配额表；某个 key 传 null 就把那个维度显式设为不限',
  })
  @IsOptional()
  @IsObject()
  quotas?: Record<string, number | null>

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description: 'null=全部可用，[]=一个都不给',
  })
  @IsOptional()
  features?: string[] | null

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  appKeys?: string[]

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  trafficMb?: number
}

/** 调整某个套餐的展示排序。 */
export class SortPlanDto {
  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsInt()
  sort!: number
}

/** 套餐列表查询。 */
export class ListPlanQueryDto {
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

  @ApiPropertyOptional({ enum: PLAN_STATUSES })
  @IsOptional()
  @IsIn(PLAN_STATUSES as readonly string[])
  status?: (typeof PLAN_STATUSES)[number]
}
