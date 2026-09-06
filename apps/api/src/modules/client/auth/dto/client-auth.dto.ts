import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches } from 'class-validator'

/** C 端联调登录。 */
export class ClientDevLoginDto {
  @ApiProperty({ type: String, description: '手机号', example: '13700000001' })
  @IsString({ message: '手机号必须是字符串' })
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone!: string
}
