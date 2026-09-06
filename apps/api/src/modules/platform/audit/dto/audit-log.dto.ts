import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

/** 平台侧审计日志查询：`PlatformAuditLog` 分页筛选。 */
export class ListPlatformAuditLogQueryDto {
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

  @ApiPropertyOptional({ type: String, description: '动作码，例如 tenant.suspend' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string

  @ApiPropertyOptional({ type: String, description: '操作者 id（PlatformAdmin.id）' })
  @IsOptional()
  @IsString()
  @MaxLength(26)
  actorId?: string

  @ApiPropertyOptional({ type: String, description: '这次操作打到了哪家店' })
  @IsOptional()
  @IsString()
  @MaxLength(26)
  targetTenantId?: string

  @ApiPropertyOptional({ type: String, description: '起始时间（含），ISO 字符串，按 createdAt 筛' })
  @IsOptional()
  @IsDateString()
  from?: string

  @ApiPropertyOptional({ type: String, description: '结束时间（含），ISO 字符串，按 createdAt 筛' })
  @IsOptional()
  @IsDateString()
  to?: string
}

/** 某个租户的审计日志查询：`AuditLog` 分页筛选。 */
export class ListTenantAuditLogQueryDto {
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

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsDateString()
  from?: string

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsDateString()
  to?: string
}
