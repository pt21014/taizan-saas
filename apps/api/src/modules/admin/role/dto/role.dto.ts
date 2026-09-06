/**
 * 角色接口的 DTO。
 *
 * DTO 只挡形状：`code` 的 kebab-case、`permissionCodes` 是不是字符串数组。
 * 「这些 code 是不是真的注册过」「有没有混进 `platform-*`」在 service 里判，
 * 因为那要读权限点注册表，而注册表是运行时注入的（`PERMISSION_REGISTRY`）。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

/** 角色 code 的格式：小写字母开头的 kebab-case，与 `@taizan/rbac-core` 的角色预设同一套。 */
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9-]*$/

/** 角色列表查询。 */
export class ListRoleQueryDto {
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

  @ApiPropertyOptional({ type: String, description: '关键字：角色名或 code，模糊匹配' })
  @IsOptional()
  @IsString({ message: 'keyword 必须是字符串' })
  @MaxLength(50, { message: 'keyword 过长' })
  keyword?: string
}

/** 新建角色。 */
export class CreateRoleDto {
  @ApiProperty({ type: String, description: '角色 code，店内唯一，kebab-case', example: 'cashier' })
  @IsString({ message: 'code 必须是字符串' })
  @MaxLength(50, { message: 'code 过长' })
  @Matches(ROLE_CODE_PATTERN, { message: "code 必须是小写 kebab-case（如 'cashier'）" })
  code!: string

  @ApiProperty({ type: String, description: '角色中文名', example: '收银员' })
  @IsString({ message: 'name 必须是字符串' })
  @MaxLength(50, { message: 'name 过长' })
  name!: string

  @ApiProperty({
    type: [String],
    description: '权限点 code 列表。**不接受通配**（`goods:*` / `*`）——见 service 的说明。',
    example: ['goods:list'],
  })
  @IsArray({ message: 'permissionCodes 必须是数组' })
  @ArrayMaxSize(500, { message: '一个角色最多挂 500 个权限点' })
  @IsString({ each: true, message: 'permissionCodes 里必须都是字符串' })
  permissionCodes!: string[]
}

/** 改角色：只改传了的字段。 */
export class UpdateRoleDto {
  @ApiPropertyOptional({ type: String, description: '角色 code（内置角色不可改）' })
  @IsOptional()
  @IsString({ message: 'code 必须是字符串' })
  @MaxLength(50, { message: 'code 过长' })
  @Matches(ROLE_CODE_PATTERN, { message: "code 必须是小写 kebab-case（如 'cashier'）" })
  code?: string

  @ApiPropertyOptional({ type: String, description: '角色中文名' })
  @IsOptional()
  @IsString({ message: 'name 必须是字符串' })
  @MaxLength(50, { message: 'name 过长' })
  name?: string

  @ApiPropertyOptional({ type: [String], description: '权限点 code 列表（整体覆盖，不是增量）' })
  @IsOptional()
  @IsArray({ message: 'permissionCodes 必须是数组' })
  @ArrayMaxSize(500, { message: '一个角色最多挂 500 个权限点' })
  @IsString({ each: true, message: 'permissionCodes 里必须都是字符串' })
  permissionCodes?: string[]
}
