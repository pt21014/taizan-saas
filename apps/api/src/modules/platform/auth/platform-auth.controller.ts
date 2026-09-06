/**
 * `/api/platform/auth` —— 平台超管登录。
 *
 * `@Public()` + `@RateLimited('login')`：登录接口必然是公开的，而公开的洞必须有限流档位
 * （`guard-default-deny.spec.ts` / spec 5 会把「有 @Public() 没 @RateLimited」判为失败）。
 * 限流的**执行**在 T2-6（`@taizan/ratelimit-core` 接线），这里先把声明立起来。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Auth, CurrentUser, Public, RateLimited, type AuthPrincipal } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { PlatformLoginDto } from './dto/platform-auth.dto'
import {
  PlatformAuthService,
  type PlatformBootstrapResponse,
  type PlatformLoginResult,
} from './platform-auth.service'

@ApiTags('platform/auth')
@Controller('api/platform/auth')
export class PlatformAuthController {
  constructor(@Inject(PlatformAuthService) private readonly auth: PlatformAuthService) {}

  @Post('login')
  @Public()
  @RateLimited('login')
  @ApiOperation({ summary: '平台超管登录（用户名 + 口令）' })
  login(@Body(Validate(PlatformLoginDto)) dto: PlatformLoginDto): Promise<PlatformLoginResult> {
    return this.auth.login(dto.username, dto.password)
  }

  @Get('me')
  @Auth('platform')
  @ApiOperation({ summary: '当前平台管理员（用来验证 token 还活着）' })
  me(@CurrentUser() user: AuthPrincipal): { id: string; kind: string } {
    return { id: user.id, kind: user.kind }
  }

  @Get('bootstrap')
  @Auth('platform')
  @ApiOperation({
    summary: '登录后拉全量上下文：身份 / 权限（本阶段全权 TODO）/ 已裁剪的 PLATFORM 侧菜单',
  })
  bootstrap(@CurrentUser() user: AuthPrincipal): Promise<PlatformBootstrapResponse> {
    return this.auth.bootstrap(user.id)
  }
}
