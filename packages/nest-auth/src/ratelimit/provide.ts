/**
 * `apps/api` 装配限流的**唯一入口**。
 *
 * @packageDocumentation
 */

import type { Provider } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { RateLimitGuard } from './rate-limit.guard'
import { RetryAfterInterceptor } from './retry-after.interceptor'

/**
 * 返回限流所需的三个 provider：守卫本体、`APP_GUARD` 注册、`Retry-After` 拦截器。
 *
 * ## 怎么用（`apps/api/src/bootstrap/app.module.ts`）
 *
 * ```ts
 * @Module({
 *   imports: [
 *     CoreModule.forRoot({ ... }),
 *     PrismaModule.forRoot({ ... }),
 *     AuthModule.forRoot({ redis }),   // 它提供 RateLimitService / RATE_LIMIT_STORE / IP_RESOLVER
 *   ],
 *   providers: [
 *     ...provideRateLimitGuard(),      // ← 放在最前面，见下
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * ## 顺序
 *
 * Nest 按 provider 的**注册先后**决定多个 `APP_GUARD` 的执行顺序。
 * 把这一行放在 `providers` 数组的最前面，`RateLimitGuard` 就会跑在
 * `GlobalAuthGuard`（由 `AuthModule.forRoot` 注册）之前——爆破者的请求
 * 因此不会先做三次验签再被拦。
 *
 * 顺序装反了**不会漏限流**（公开路由上认证守卫直接放行，接着还是会走到限流守卫），
 * 只是白做一次认证，所以这一条是性能问题不是安全问题。
 *
 * ## 为什么不塞进 `AuthModule.forRoot`
 *
 * 因为那样就没法把它排在 `GlobalAuthGuard` 前面了（同一个模块里两个 `APP_GUARD`
 * 的相对顺序由数组顺序定，跨模块则由模块顺序定，而 `AuthModule` 必须在
 * `CoreModule` 之后）。拆成一个显式的 `providers` 项，顺序就写在应用自己手里，
 * 而且在 `app.module.ts` 里一眼看得见——守卫链的顺序是安全语义，
 * 蓝图 §4.3 要求它在一处定死、看得见。
 */
export function provideRateLimitGuard(): Provider[] {
  return [
    RateLimitGuard,
    // useExisting 而不是 useClass：只要一个实例，那些「已经 warn 过」的 Set 才不会各记各的。
    { provide: APP_GUARD, useExisting: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: RetryAfterInterceptor },
  ]
}
