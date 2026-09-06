/**
 * 邀请核销的 DTO。
 *
 * @packageDocumentation
 */

import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches, MaxLength, MinLength } from 'class-validator'

/** 手机号形状。与 `public/signup`、`admin/staff` 三处口径一致。 */
const PHONE_PATTERN = /^1\d{10}$/

/** 接受邀请。 */
export class AcceptInviteDto {
  @ApiProperty({ type: String, description: '手机号（就是将来的登录名）', example: '13800000005' })
  @Matches(PHONE_PATTERN, { message: '手机号格式不正确' })
  phone!: string

  @ApiProperty({
    type: String,
    description:
      '密码。这个手机号**已经**有账号时，这里必须填它现有的登录密码（验通才让加入，' +
      '且永远不覆盖原口令）；没有账号时这就是新账号的初始密码。',
  })
  @IsString({ message: 'password 必须是字符串' })
  @MinLength(6, { message: '密码至少 6 位' })
  @MaxLength(128, { message: '密码过长' })
  password!: string
}
