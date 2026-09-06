/**
 * `/api/client/auth` —— C 端身份。
 *
 * `/api/client/*` **进租户中间件且保持失败关闭**：C 端在用户登录之前就得靠
 * `X-Tenant-Slug` / 子域名选店，解析不出来就是真的「这家店不存在」，1240400 是对的答案。
 * （对照 `/api/admin/*`：那里只认 token 且解析不到时留空，见 `TENANT_TOKEN_ONLY_PREFIXES`。）
 *
 * @packageDocumentation
 */

import { Body, Controller, Inject, Post } from '@nestjs/common'
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public, RateLimited, TENANT_SLUG_HEADER } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { ClientAuthService, type ClientLoginResult } from './client-auth.service'
import { ClientDevLoginDto } from './dto/client-auth.dto'

@ApiTags('client/auth')
@Controller('api/client/auth')
@ApiHeader({ name: TENANT_SLUG_HEADER, description: '店铺 slug，C 端靠它选店', required: true })
export class ClientAuthController {
  constructor(@Inject(ClientAuthService) private readonly auth: ClientAuthService) {}

  @Post('login-dev')
  @Public()
  @RateLimited('login')
  @ApiOperation({
    summary: '【联调用】只凭手机号签发会员 token；需要 CLIENT_DEV_LOGIN=1，生产环境会拒启',
  })
  loginDev(@Body(Validate(ClientDevLoginDto)) dto: ClientDevLoginDto): Promise<ClientLoginResult> {
    return this.auth.loginDev(dto.phone)
  }
}
