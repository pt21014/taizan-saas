/**
 * `GET /api/admin/auth/bootstrap`（蓝图 §4.4）与它在 `/api/admin/bootstrap` 上的同名入口。
 *
 * ## 为什么是两条 URL
 *
 * 蓝图 §4.4 把这个接口写成 `GET /api/admin/auth/bootstrap`，四端协议按那个形状对齐，
 * 所以它是**正式入口**。但 `ALWAYS_WRITABLE_PREFIXES`（`@taizan/billing-rules`）里
 * 同时列了 `/api/admin/bootstrap` 这条前缀——续费白名单的三条各有各的理由，
 * bootstrap 那条是「到期后商家至少得看得到『后台只读中，请续费』这句话，
 * 而不是一个白屏」。
 *
 * `billing-routes.spec.ts`（spec 8）会断言白名单里的每一条都有真实控制器兑现。
 * 于是只有两条路可走：改 `@taizan/billing-rules` 的白名单常量（那是框架契约，
 * 且 `/api/admin/bootstrap` 本身是个合理的前缀），或者在这里把它兑现。选后者。
 *
 * 两条 URL 指向**同一个 service 方法**，不是两份实现——所以它们不会漂。
 * 前端应当只用 `/api/admin/auth/bootstrap`。
 *
 * **TODO(T3-2)**：前端接完之后，如果确认没有任何调用方用 `/api/admin/bootstrap`，
 * 可以考虑把正式入口挪过来、删掉 `/api/admin/auth/bootstrap`——那时两条 URL 变一条，
 * 白名单也就名副其实了。现在不挪，是因为 e2e 与四端协议都写着旧的那条。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { BootstrapResponse } from '@taizan/contracts'
import { Auth, CurrentUser, type AuthPrincipal } from '@taizan/nest-auth'

import { BootstrapService } from './bootstrap.service'

@ApiTags('admin/auth')
@Controller('api/admin/auth')
@Auth('staff')
export class BootstrapController {
  constructor(@Inject(BootstrapService) private readonly bootstrap: BootstrapService) {}

  @Get('bootstrap')
  @ApiOperation({
    summary: '登录后拉全量上下文：身份 / 当前店 / 可切换店铺 / 权限点 / 菜单 / 配额',
  })
  build(@CurrentUser() user: AuthPrincipal): Promise<BootstrapResponse> {
    return this.bootstrap.build(user)
  }
}

/**
 * 续费白名单前缀 `/api/admin/bootstrap` 的兑现者。见本文件头。
 *
 * 它只有一行转发，没有自己的逻辑——有逻辑就意味着两条 URL 会给出不同的答案，
 * 那正是「同一件事两份实现」的经典起点。
 */
@ApiTags('admin/auth')
@Controller('api/admin/bootstrap')
@Auth('staff')
export class BootstrapAliasController {
  constructor(@Inject(BootstrapService) private readonly bootstrap: BootstrapService) {}

  @Get()
  @ApiOperation({
    summary: '同 GET /api/admin/auth/bootstrap（续费白名单前缀上的等价入口）',
  })
  build(@CurrentUser() user: AuthPrincipal): Promise<BootstrapResponse> {
    return this.bootstrap.build(user)
  }
}
