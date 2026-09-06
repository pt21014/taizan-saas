/**
 * 员工模块的 DTO。
 *
 * 分层同 `example-goods/dto/goods.dto.ts`：DTO 只挡形状，业务规则（能不能授予某个角色、
 * 能不能停用某个人）在 service 里，因为邀请核销走的是 `/api/public` 那条完全不同的入口，
 * 规则只写在 DTO 上那条路径就一点校验都没有。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

/** `Staff.status` 里商家后台能设置的两档（`LEFT` 由「移出店铺」流程写，不开放给这里）。 */
export const STAFF_SETTABLE_STATUSES = ['ACTIVE', 'DISABLED'] as const

/** 手机号形状。与 `public/signup` 的口径保持一致：11 位、1 开头。 */
const PHONE_PATTERN = /^1\d{10}$/

/** 员工列表查询。 */
export class ListStaffQueryDto {
  @ApiPropertyOptional({ type: Number, description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 从 1 开始' })
  page?: number

  @ApiPropertyOptional({ type: Number, description: '每页条数，上限 200', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 至少为 1' })
  @Max(200, { message: 'pageSize 上限 200' })
  pageSize?: number

  @ApiPropertyOptional({ type: String, description: '关键字：店内昵称或手机号，模糊匹配' })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(50, { message: 'keyword 过长' })
  keyword?: string

  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED', 'LEFT'], description: '按状态筛选' })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED', 'LEFT'], { message: '状态只能是 ACTIVE / DISABLED / LEFT' })
  status?: 'ACTIVE' | 'DISABLED' | 'LEFT'
}

/** 生成一张邀请。 */
export class CreateStaffInviteDto {
  @ApiPropertyOptional({
    type: String,
    description: '限定手机号；不填 = 任何人凭链接可入（链接本身就是凭证，别往群里发）',
    example: '13800000005',
  })
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: '手机号格式不正确' })
  phone?: string

  @ApiProperty({
    type: [String],
    description: '入职后挂哪些角色（`Role.id`）。可以是空数组 = 先进来，角色回头再配。',
    example: [],
  })
  @IsArray({ message: 'roleIds 必须是数组' })
  @ArrayMaxSize(20, { message: '一次最多挂 20 个角色' })
  @IsString({ each: true, message: 'roleIds 里必须都是字符串' })
  roleIds!: string[]

  @ApiPropertyOptional({
    type: Number,
    description: '有效期（小时），默认 72，上限 720（30 天）',
    default: 72,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'expiresInHours 必须是整数' })
  @Min(1, { message: '有效期至少 1 小时' })
  @Max(720, { message: '有效期最长 720 小时（30 天）' })
  expiresInHours?: number
}

/** 改员工：只改传了的字段。 */
export class UpdateStaffDto {
  @ApiPropertyOptional({ type: String, description: '店内昵称' })
  @IsOptional()
  @IsString({ message: 'name 必须是字符串' })
  @MaxLength(50, { message: '昵称过长' })
  name?: string

  @ApiPropertyOptional({ type: [String], description: '角色 id 列表（整体覆盖，不是增量）' })
  @IsOptional()
  @IsArray({ message: 'roleIds 必须是数组' })
  @ArrayMaxSize(20, { message: '一次最多挂 20 个角色' })
  @IsString({ each: true, message: 'roleIds 里必须都是字符串' })
  roleIds?: string[]
}

/** 转让店主。 */
export class TransferOwnerDto {
  @ApiProperty({ type: String, description: '接手人的 `Staff.id`（必须是本店在职员工）' })
  @IsString({ message: 'staffId 必须是字符串' })
  @MaxLength(26, { message: 'staffId 过长' })
  staffId!: string
}
