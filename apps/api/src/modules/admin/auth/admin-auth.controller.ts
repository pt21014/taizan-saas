/**
 * `/api/admin/auth` —— 商家后台的登录 / 换店 / 登出。
 *
 * ## 这条前缀有两个特殊之处
 *
 * 1. **`ALWAYS_WRITABLE_PREFIXES` 之一**：套餐到期后商家后台转只读，但
 *    `/api/admin/auth`、`/api/admin/billing`、`/api/admin/bootstrap` 永远可写。
 *    锁掉它们就是「到期 → 后台只读 → 续不了费 → 永远到期」的死循环。
 * 2. **`/api/admin/*` 属于 `TENANT_TOKEN_ONLY_PREFIXES`**：租户中间件在这条前缀下
 *    只跑 token 策略，且解析不到时留空放行——于是没带 token 打商家后台拿到的是
 *    1140100（未登录，前端跳登录页），而不是 1240400（店铺不存在，前端一脸茫然）。
 *    登录接口本身是 `@Public()` 的，正好需要这个行为。
 *
 * @packageDocumentation
 */

import { Body, Controller, Inject, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Auth, CurrentUser, Public, RateLimited, type AuthPrincipal } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { AdminLoginDto, SwitchTenantDto } from './dto/admin-auth.dto'
import { AdminAuthService, type AdminLoginResult } from './admin-auth.service'

@ApiTags('admin/auth')
@Controller('api/admin/auth')
export class AdminAuthController {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}

  @Post('login')
  @Public()
  @RateLimited('login')
  @ApiOperation({
    summary: '商家登录（手机号 + 口令）；名下多店时返回选店列表而不是 token',
  })
  login(@Body(Validate(AdminLoginDto)) dto: AdminLoginDto): Promise<AdminLoginResult> {
    return this.auth.login(dto.phone, dto.password, dto.tenantId)
  }

  @Post('switch')
  @Auth('staff')
  @RateLimited('login')
  @ApiOperation({ summary: '换店：重签一个绑到目标店的新 token（旧 token 不吊销）' })
  switch(
    @CurrentUser() user: AuthPrincipal,
    @Body(Validate(SwitchTenantDto)) dto: SwitchTenantDto,
  ): Promise<AdminLoginResult> {
    return this.auth.switchTenant(user, dto.tenantId)
  }

  @Post('logout')
  @Auth('staff')
  @ApiOperation({ summary: '登出当前会话（其它端不受影响）' })
  async logout(@CurrentUser() user: AuthPrincipal): Promise<{ ok: true }> {
    await this.auth.logout(user)
    return { ok: true }
  }
}
