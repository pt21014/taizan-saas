import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator'

/** 商家员工登录。 */
export class AdminLoginDto {
  @ApiProperty({ type: String, description: '手机号（登录名）', example: '13900000001' })
  @IsString({ message: '手机号必须是字符串' })
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone!: string

  @ApiProperty({ type: String, description: '口令' })
  @IsString({ message: '口令必须是字符串' })
  @MinLength(1, { message: '口令不能为空' })
  @MaxLength(200, { message: '口令过长' })
  password!: string

  @ApiPropertyOptional({
    type: String,
    description: '要进哪家店。不给时：名下只有一家就直接登录，多家则回一张选店列表（不发 token）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(26)
  tenantId?: string
}

/** 换店。 */
export class SwitchTenantDto {
  @ApiProperty({ type: String, description: '目标店铺 id（必须在自己名下）' })
  @IsString({ message: 'tenantId 必须是字符串' })
  @MinLength(1, { message: 'tenantId 不能为空' })
  @MaxLength(26)
  tenantId!: string
}
