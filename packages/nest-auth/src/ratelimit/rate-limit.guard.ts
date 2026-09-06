/**
 * `@RateLimited(tier)` 的执行者。
 *
 * ## 它在守卫链里的位置：**GlobalAuthGuard 之前**
 *
 * ```
 * RateLimitGuard → GlobalAuthGuard → PermissionsGuard → BillingGateGuard → …
 * ```
 *
 * 放前面的理由：认证本身是要花钱的（三次 HMAC 验签 + 一次 Redis 查会话 +
 * staff 还要查一次成员关系）。一个拿着垃圾 token 每秒打一千次的人，
 * 放在认证之后限流意味着这一千次全都做完了才被拦。
 *
 * 顺序由 `apps/api/src/bootstrap/app.module.ts` 里 provider 的先后决定，
 * 用 {@link provideRateLimitGuard} 把它放在 `AuthModule.forRoot()` **之前**。
 * 退一步说，顺序反了也不会漏限流（公开路由上 `GlobalAuthGuard` 直接放行，
 * 紧接着还是会走到这里），只是白做了一次认证。
 *
 * ## 没有 `@RateLimited` 的路由不限流
 *
 * 刻意的：给每条内部接口都套一层 Redis 往返不划算，而它们本来就在认证之后。
 * 真正必须有档位的是 `@Public()` 路由——那一条由蓝图 §8 spec 5 静态强制，
 * 且 `GlobalAuthGuard` 在运行时也会 warn。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { RATE_LIMIT_KEY } from '../decorators'
import type { AuthPrincipal } from '../principal'
import {
  RateLimitedException,
  setRetryAfter,
  type HeaderSettableResponse,
} from './rate-limit.exception'
import { RateLimitService } from './rate-limit.service'

/** `Reflector.getAllAndOverride` 的第二个参数类型（handler + class）。 */
type ReflectorTargets = Parameters<Reflector['getAllAndOverride']>[1]

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 只管 HTTP。队列消费者、cron tick 没有「客户端 IP」这个概念。
    if (context.getType() !== 'http') return true

    const targets: ReflectorTargets = [context.getHandler(), context.getClass()]
    const tier = this.reflector.getAllAndOverride<string>(RATE_LIMIT_KEY, targets)
    if (!tier) return true

    const req = context.switchToHttp().getRequest<{ principal?: AuthPrincipal }>()

    // 已登录时把账号维度也带上。**注意本守卫跑在认证之前**，所以这里通常是 undefined——
    // 真正需要账号维度的是登录/注册这些「还没登录」的入口，它们的账号是请求体里那个
    // 手机号/用户名，只有业务流程知道，由 AuthFlowService 在拿到它之后补算一次。
    // 这里的 principal 分支覆盖的是另一种情况：认证守卫排在了前面（顺序装反了），
    // 或者某条已登录的重接口也挂了档位。
    const principal = req.principal
    const account = principal ? (principal.accountId ?? principal.id) : undefined

    try {
      await this.rateLimit.consume(tier, { ...(account ? { account } : {}) })
    } catch (error) {
      if (error instanceof RateLimitedException) {
        // 守卫抛的异常**不经过拦截器**（Nest 的顺序是 中间件 → 守卫 → 拦截器），
        // 所以这里必须自己写 Retry-After，不能指望 RetryAfterInterceptor。
        setRetryAfter(
          context.switchToHttp().getResponse<HeaderSettableResponse>(),
          error.retryAfterSec,
        )
      }
      throw error
    }

    return true
  }
}
