/**
 * 商家侧审计查询的 DTO。
 *
 * 形状与平台侧的 `ListTenantAuditLogQueryDto` 刻意保持一致（少了 `targetTenantId`——
 * 商家只能看自己家的），这样前端两套后台的审计页可以共用同一个查询组件。
 *
 * @packageDocumentation
 */

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

/** 本店操作日志查询。 */
export class ListAuditLogQueryDto {
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

  @ApiPropertyOptional({ type: String, description: '动作码，例如 goods.create' })
  @IsOptional()
  @IsString({ message: 'action 必须是字符串' })
  @MaxLength(80, { message: 'action 过长' })
  action?: string

  @ApiPropertyOptional({
    type: String,
    description: '动作码的模块段，例如 `staff`（等价于 `action LIKE "staff.%"`）',
  })
  @IsOptional()
  @IsString({ message: 'module 必须是字符串' })
  @MaxLength(40, { message: 'module 过长' })
  module?: string

  @ApiPropertyOptional({ type: String, description: '操作者 id（Staff.id / Member.id）' })
  @IsOptional()
  @IsString({ message: 'actorId 必须是字符串' })
  @MaxLength(26, { message: 'actorId 过长' })
  actorId?: string

  @ApiPropertyOptional({ enum: ['SUCCESS', 'FAIL'], description: '只看成功的或只看失败的' })
  @IsOptional()
  @IsIn(['SUCCESS', 'FAIL'], { message: 'result 只能是 SUCCESS / FAIL' })
  result?: 'SUCCESS' | 'FAIL'

  @ApiPropertyOptional({ type: String, description: '起始时间（含），ISO 字符串，按 createdAt 筛' })
  @IsOptional()
  @IsDateString({}, { message: 'from 必须是 ISO 时间字符串' })
  from?: string

  @ApiPropertyOptional({ type: String, description: '结束时间（含），ISO 字符串，按 createdAt 筛' })
  @IsOptional()
  @IsDateString({}, { message: 'to 必须是 ISO 时间字符串' })
  to?: string
}
