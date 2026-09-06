import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PHONE_PATTERN,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
} from '@taizan/provision'
import { Type } from 'class-transformer'
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

/** 租户状态全集，与 `01-tenant.prisma` 的 `TenantStatus` 一一对应（刻意没有 EXPIRED）。 */
export const TENANT_STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'DEREGISTERED'] as const

/**
 * 平台后台开通一家店。
 *
 * ## 形状规则一律从 `@taizan/provision` import
 *
 * slug 的正则与长度、店名长度、手机号形状、口令长度**不在这里重写一遍**（T1-8）。
 * 各写各的下场是「后台能开出注册页开不出来的店」——比如后台允许 2 位 slug、
 * 注册页不允许，于是同一张表里出现了两种规格的路径，而 slug 是不可改的。
 * DTO 这一层只是提前给出友好提示，最终判定仍在 `provisionTenant()` 里。
 */
export class CreateTenantDto {
  @ApiProperty({
    type: String,
    description: '店铺 slug，全局唯一且不可改（子域名/回调都靠它）',
    example: 'shop-a',
  })
  @IsString({ message: 'slug 必须是字符串' })
  @Matches(SLUG_PATTERN, {
    message:
      `店铺路径只能用小写字母、数字和连字符，${String(SLUG_MIN_LENGTH)}–` +
      `${String(SLUG_MAX_LENGTH)} 位，且不能以连字符开头或结尾`,
  })
  slug!: string

  @ApiProperty({ type: String, description: '店铺名', example: 'A 家便利店' })
  @IsString({ message: '店铺名必须是字符串' })
  @MinLength(NAME_MIN_LENGTH, { message: `店铺名至少 ${String(NAME_MIN_LENGTH)} 个字` })
  @MaxLength(NAME_MAX_LENGTH, { message: `店铺名最多 ${String(NAME_MAX_LENGTH)} 个字` })
  name!: string

  @ApiProperty({
    type: String,
    description: '店主手机号（同时是登录名，全局唯一）',
    example: '13900000001',
  })
  @IsString({ message: '手机号必须是字符串' })
  @Matches(PHONE_PATTERN, { message: '手机号格式不正确' })
  ownerPhone!: string

  @ApiPropertyOptional({ type: String, description: '店主显示名，不给就用店铺名' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ownerName?: string

  @ApiPropertyOptional({
    type: String,
    description:
      '店主初始口令。不给就随机生成一个回给运营；手机号已有账号时它是「商家自己填的现有口令」，' +
      '验过才让开新店（provision 永不覆盖已有口令）',
  })
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: `口令至少 ${String(PASSWORD_MIN_LENGTH)} 位` })
  @MaxLength(PASSWORD_MAX_LENGTH)
  ownerPassword?: string

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      '【高危·运营专用】手机号已有账号时跳过「验原口令」，直接把新店挂到那个账号下。' +
      '运营拿不到商家的口令，这是唯一的替代路径；必须显式传 true，会写一条 ' +
      'tenant.create-attach-existing 平台审计，响应里也会明确回「已绑定既有账号」。' +
      '手机号还没有账号时传它会被直接拒绝（绝不退化成「用占位口令建新账号」）',
  })
  @IsOptional()
  @IsBoolean({ message: 'attachExistingAccount 必须是布尔值' })
  attachExistingAccount?: boolean

  @ApiPropertyOptional({ type: String, description: '挂哪个套餐（Plan.id）' })
  @IsOptional()
  @IsString()
  planId?: string

  @ApiPropertyOptional({ type: Number, description: '试用天数', default: 14 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '试用天数必须是整数' })
  @Min(0, { message: '试用天数不能为负' })
  @Max(3650, { message: '试用天数太长了，确认一下是不是填错了' })
  trialDays?: number
}

/** 租户列表查询。 */
export class ListTenantQueryDto {
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

  @ApiPropertyOptional({ enum: TENANT_STATUSES })
  @IsOptional()
  @IsIn(TENANT_STATUSES as readonly string[], {
    message: `状态只能是 ${TENANT_STATUSES.join(' / ')}`,
  })
  status?: (typeof TENANT_STATUSES)[number]

  @ApiPropertyOptional({ type: String, description: '按店名或 slug 模糊搜索' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  keyword?: string
}

/** 续期。TODO(T1-5)：这里的「下单即履约」是临时形状，T1-5 落地后走统一 fulfill 路径。 */
export class RenewTenantDto {
  @ApiPropertyOptional({ type: String, description: '换套餐续期时传；不传就沿用当前套餐' })
  @IsOptional()
  @IsString()
  planId?: string

  @ApiProperty({ type: Number, description: '买几个计费周期', default: 1 })
  @Type(() => Number)
  @IsInt({ message: '周期数必须是整数' })
  @Min(1, { message: '周期数至少为 1' })
  @Max(120, { message: '一次最多买 120 个周期，确认一下是不是填错了' })
  periods!: number
}

/** 更换套餐（不改到期日，只切换配额/功能白名单口径）。 */
export class ChangeTenantPlanDto {
  @ApiProperty({ type: String, description: '目标 Plan.id' })
  @IsString({ message: 'planId 必须是字符串' })
  @MinLength(1, { message: 'planId 不能为空' })
  planId!: string
}

/** 重置店主登录口令。 */
export class ResetOwnerPasswordDto {
  @ApiPropertyOptional({
    type: String,
    description: '不给就随机生成一个回给调用方',
  })
  @IsOptional()
  @IsString()
  @MinLength(6, { message: '口令至少 6 位' })
  @MaxLength(200)
  newPassword?: string
}
