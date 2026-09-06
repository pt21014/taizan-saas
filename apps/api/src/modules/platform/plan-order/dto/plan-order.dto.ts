import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { MAX_PERIODS_PER_ORDER } from '@taizan/billing-rules'
import { PAY_CHANNELS } from '@taizan/payment-core'
import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

/**
 * 平台运营代下单。
 *
 * `periods` 的上限直接用 `@taizan/billing-rules` 的 `MAX_PERIODS_PER_ORDER`，
 * 不在这里另抄一个数字：抄一份就会有对不上的那天，而对不上的表现是
 * DTO 放行了一个 `computeRenewal` 会抛 `RangeError` 的值——500 而不是 1040000。
 */
export class CreatePlanOrderDto {
  @ApiProperty({ type: String, description: '给哪家店下单（Tenant.id）' })
  @IsString({ message: 'tenantId 必须是字符串' })
  @MinLength(1)
  @MaxLength(26)
  tenantId!: string

  @ApiProperty({ type: String, description: '买哪个套餐（Plan.id）' })
  @IsString({ message: 'planId 必须是字符串' })
  @MinLength(1)
  @MaxLength(26)
  planId!: string

  @ApiProperty({ type: Number, description: '买几个计费周期', default: 1 })
  @Type(() => Number)
  @IsInt({ message: '周期数必须是整数' })
  @Min(1, { message: '至少买 1 个周期' })
  @Max(MAX_PERIODS_PER_ORDER, { message: `一次最多买 ${MAX_PERIODS_PER_ORDER} 个周期` })
  periods!: number

  @ApiPropertyOptional({
    enum: PAY_CHANNELS,
    default: 'OFFLINE',
    description: '收款渠道。运营代下单默认 OFFLINE（线下打款后再「标记已付」）',
  })
  @IsOptional()
  @IsIn(PAY_CHANNELS as readonly string[], { message: '不认识的收款渠道' })
  channel?: (typeof PAY_CHANNELS)[number]
}

/** 平台后台发起退款。 */
export class RefundPlanOrderDto {
  @ApiProperty({ type: String, description: '退款原因，会写进审计，也会带给渠道展示给用户' })
  @IsString({ message: '退款原因必须是字符串' })
  @MinLength(2, { message: '退款原因至少 2 个字——「测试」这种也比空着强，事后要看得懂' })
  @MaxLength(200)
  reason!: string
}

/** 商家自助下单（`/api/admin/billing/orders`）：租户来自 token，不接受前端传。 */
export class CreateSelfPlanOrderDto {
  @ApiProperty({ type: String, description: '买哪个套餐（Plan.id）' })
  @IsString({ message: 'planId 必须是字符串' })
  @MinLength(1)
  @MaxLength(26)
  planId!: string

  @ApiProperty({ type: Number, description: '买几个计费周期', default: 1 })
  @Type(() => Number)
  @IsInt({ message: '周期数必须是整数' })
  @Min(1, { message: '至少买 1 个周期' })
  @Max(MAX_PERIODS_PER_ORDER, { message: `一次最多买 ${MAX_PERIODS_PER_ORDER} 个周期` })
  periods!: number

  @ApiPropertyOptional({
    type: String,
    description: '付款人 openid（JSAPI 下单要）。不传按 NATIVE（扫码）处理',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  openId?: string
}

/** 商家账单分页。 */
export class ListSelfPlanOrderQueryDto {
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
