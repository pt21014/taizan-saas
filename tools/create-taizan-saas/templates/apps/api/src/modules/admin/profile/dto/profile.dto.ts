/**
 * 个人设置的 DTO。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

/** 口令长度下限。与 `public/signup` 的口径一致。 */
const PASSWORD_MIN = 6
/** 口令长度上限。scrypt 对超长输入没有额外风险，卡它只是防止有人贴一本书进来。 */
const PASSWORD_MAX = 128

/** 改自己的资料。 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ type: String, description: '账号显示名（顶栏那个名字）' })
  @IsOptional()
  @IsString({ message: 'name 必须是字符串' })
  @MaxLength(50, { message: '名字过长' })
  name?: string

  @ApiPropertyOptional({ type: String, description: '头像 URL；传空串表示清空' })
  @IsOptional()
  @IsString({ message: 'avatar 必须是字符串' })
  @MaxLength(500, { message: '头像地址过长' })
  avatar?: string
}

/** 改自己的密码。 */
export class ChangePasswordDto {
  @ApiProperty({ type: String, description: '当前密码' })
  @IsString({ message: 'oldPassword 必须是字符串' })
  @MaxLength(PASSWORD_MAX, { message: '密码过长' })
  oldPassword!: string

  @ApiProperty({ type: String, description: '新密码，至少 6 位' })
  @IsString({ message: 'newPassword 必须是字符串' })
  @MinLength(PASSWORD_MIN, { message: `新密码至少 ${PASSWORD_MIN} 位` })
  @MaxLength(PASSWORD_MAX, { message: '新密码过长' })
  newPassword!: string
}
