/**
 * 自助注册的入参。
 *
 * 形状规则（slug 正则与长度、店名长度、手机号、口令长度）**全部从
 * `@taizan/provision` import**，这里一个字都不重写——理由见 `signup.rules.ts` 文件头。
 *
 * @packageDocumentation
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PHONE_PATTERN,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
} from '@taizan/provision'
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator'

/** `POST /api/public/signup` 的请求体。 */
export class SignupDto {
  @ApiProperty({
    type: String,
    description: '店铺路径，全局唯一且**不可改**（子域名、支付回调、印在物料上的链接都用它）',
    example: 'my-shop',
  })
  @IsString({ message: '请填写店铺路径' })
  @Matches(SLUG_PATTERN, {
    message:
      `店铺路径只能用小写字母、数字和连字符，${String(SLUG_MIN_LENGTH)}–` +
      `${String(SLUG_MAX_LENGTH)} 位，且不能以连字符开头或结尾`,
  })
  slug!: string

  @ApiProperty({ type: String, description: '店铺名称', example: '楼下便利店' })
  @IsString({ message: '请填写店铺名称' })
  @MinLength(NAME_MIN_LENGTH, {
    message: `店铺名称 ${String(NAME_MIN_LENGTH)}–${String(NAME_MAX_LENGTH)} 个字`,
  })
  @MaxLength(NAME_MAX_LENGTH, {
    message: `店铺名称 ${String(NAME_MIN_LENGTH)}–${String(NAME_MAX_LENGTH)} 个字`,
  })
  name!: string

  @ApiProperty({ type: String, description: '店主手机号，同时是登录名', example: '13900000001' })
  @IsString({ message: '请填写手机号' })
  @Matches(PHONE_PATTERN, { message: '手机号填错了，要 11 位' })
  phone!: string

  @ApiProperty({
    type: String,
    description: '登录密码（新账号用它注册）',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString({ message: '请设置登录密码' })
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `密码 ${String(PASSWORD_MIN_LENGTH)}–${String(PASSWORD_MAX_LENGTH)} 位`,
  })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `密码 ${String(PASSWORD_MIN_LENGTH)}–${String(PASSWORD_MAX_LENGTH)} 位`,
  })
  password!: string

  @ApiPropertyOptional({
    type: String,
    description:
      '这个手机号**已经开过店**时必填：填它**现有**的登录密码，新店会挂在同一个账号下。' +
      '验不过什么都不建，也**永远不会**覆盖原来的密码（覆盖等于给平台开了一个改密后门）。' +
      '手机号还没注册过时本字段被忽略',
    minLength: 1,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  existingPassword?: string

  @ApiPropertyOptional({
    type: String,
    description:
      '图形验证码 id（`GET /api/public/signup/captcha` 拿）。与 captchaCode 成对出现；' +
      '两者都不传时跳过图形验证码这道筛子，只靠限流兜底',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  captchaId?: string

  @ApiPropertyOptional({ type: String, description: '图形验证码答案，不区分大小写' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  captchaCode?: string
}

/** `GET /api/public/signup/check-slug` 的查询串。 */
export class CheckSlugQueryDto {
  @ApiProperty({ type: String, description: '要查的店铺路径' })
  @IsString({ message: '请填写店铺路径' })
  @MaxLength(64)
  slug!: string
}
