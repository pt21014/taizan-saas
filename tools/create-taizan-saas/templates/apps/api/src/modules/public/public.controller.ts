/**
 * `/api/public` —— 免登录、免租户的公共接口。
 *
 * 这条命名空间**不进租户中间件**（`TENANT_FREE_PREFIXES`）：自助注册、找回密码、
 * 扫码进店前的落地页——这时候店铺还不存在，或者请求方压根还没选店。
 * 中间件在这里失败关闭会把注册页变成 404，而那正是 knowledge 上真实发生过的事故
 * （蓝图 spec 16 的守护对象）。
 *
 * T0-8 只放一个最小的健康回声接口，用来证明：
 * - `@Public()` 确实能绕过全局守卫（默认拒绝的反面样本）；
 * - 免租户前缀确实不解析租户（上下文里 `tenantId` 是空的）。
 *
 * T1-8 会在这里补 `/api/public/signup`（自助注册）与 `site-config`。
 *
 * @packageDocumentation
 */

import { Controller, Get, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { currentContext } from '@taizan/nest-core'
import { Public, RateLimited } from '@taizan/nest-auth'

/** 回声响应。 */
export interface HealthEcho {
  echo: string
  /** 当前上下文里的租户；免租户前缀下必然是 `null`。 */
  tenantId: string | null
  /** 当前身份；`@Public()` 路由上必然是 `null`。 */
  identityKind: string | null
  traceId: string
}

@ApiTags('public')
@Controller('api/public')
export class PublicController {
  @Get('health-echo')
  @Public()
  @RateLimited('public-default')
  @ApiOperation({ summary: '回声：验证 @Public() 放行、免租户前缀不解析租户、traceId 已注入' })
  echo(@Query('text') text?: string): HealthEcho {
    const ctx = currentContext()
    return {
      echo: text ?? 'pong',
      tenantId: ctx?.tenantId ?? null,
      identityKind: ctx?.identity?.kind ?? null,
      traceId: ctx?.traceId ?? '',
    }
  }
}
