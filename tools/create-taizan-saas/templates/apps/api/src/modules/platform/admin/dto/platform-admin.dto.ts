import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

/** 平台管理员启停状态全集，与 `03-identity.prisma` 的 `AccountStatus` 一一对应。 */
export const ADMIN_STATUSES = ['ACTIVE', 'DISABLED'] as const

/** 新建平台管理员。 */
export class CreateAdminDto {
  @ApiProperty({ type: String, description: '登录用户名，全局唯一' })
  @IsString({ message: '用户名必须是字符串' })
  @MinLength(1, { message: '用户名不能为空' })
  @MaxLength(64, { message: '用户名过长' })
  username!: string

  @ApiPropertyOptional({ type: String, description: '初始口令，不给就随机生成一个回给调用方' })
  @IsOptional()
  @IsString()
  @MinLength(6, { message: '初始口令至少 6 位' })
  @MaxLength(200)
  password?: string

  @ApiProperty({ type: String, description: '显示名' })
  @IsString({ message: '显示名必须是字符串' })
  @MinLength(1, { message: '显示名不能为空' })
  @MaxLength(60)
  name!: string

  @ApiPropertyOptional({
    type: [String],
    description: 'RolePreset.id 数组（必须是 side=PLATFORM 的模板），不给就是一个角色都没有',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleIds?: string[]
}

/** 修改平台管理员（名字 / 角色，不改用户名与状态）。 */
export class UpdateAdminDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string

  @ApiPropertyOptional({ type: [String], description: 'RolePreset.id 数组，整体覆盖' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleIds?: string[]
}

/** 重置某个管理员的口令。 */
export class SetAdminPasswordDto {
  @ApiPropertyOptional({ type: String, description: '不给就随机生成一个回给调用方' })
  @IsOptional()
  @IsString()
  @MinLength(6, { message: '口令至少 6 位' })
  @MaxLength(200)
  newPassword?: string
}

/** 管理员列表查询。 */
export class ListAdminQueryDto {
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

  @ApiPropertyOptional({ enum: ADMIN_STATUSES })
  @IsOptional()
  @IsIn(ADMIN_STATUSES as readonly string[], {
    message: `状态只能是 ${ADMIN_STATUSES.join(' / ')}`,
  })
  status?: (typeof ADMIN_STATUSES)[number]

  @ApiPropertyOptional({ type: String, description: '按用户名或显示名模糊搜索' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  keyword?: string
}
