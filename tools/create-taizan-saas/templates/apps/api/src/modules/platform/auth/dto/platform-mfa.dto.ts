import { ApiProperty } from '@nestjs/swagger'
import { IsString, Length, Matches } from 'class-validator'

/** 校验一枚 TOTP 一次性码。 */
export class VerifyMfaDto {
  @ApiProperty({ type: String, description: '认证器 app 上的 6 位一次性码', example: '123456' })
  @IsString({ message: '验证码必须是字符串' })
  @Length(6, 6, { message: '验证码必须是 6 位数字' })
  @Matches(/^\d{6}$/, { message: '验证码必须是 6 位数字' })
  code!: string
}
