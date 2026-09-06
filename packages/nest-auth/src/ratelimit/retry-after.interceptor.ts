/**
 * 给**业务流程里**抛出来的 429 补上 `Retry-After` 头。
 *
 * ## 为什么守卫写了一遍这里还要再写一遍
 *
 * Nest 的执行顺序是 `中间件 → 守卫 → 拦截器 → 管道 → 处理器`。
 * 守卫抛的异常**不经过拦截器**，处理器（以及它调用的 `AuthFlowService`）
 * 抛的异常才经过。两条路径各自独立，所以两处都要写：
 *
 * - `RateLimitGuard` 自己写头（守卫阶段）；
 * - 本拦截器写头（处理器阶段，例如登录时账号维度触顶）。
 *
 * 只写一处的表现是「有时候有 Retry-After，有时候没有」——而客户端的重试逻辑
 * 会因此在两条路径上行为不一致，排查起来非常费劲。
 *
 * @packageDocumentation
 */

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common'
import type { Observable } from 'rxjs'
import { catchError } from 'rxjs/operators'
import {
  RateLimitedException,
  setRetryAfter,
  type HeaderSettableResponse,
} from './rate-limit.exception'

@Injectable()
export class RetryAfterInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle()

    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof RateLimitedException) {
          setRetryAfter(
            context.switchToHttp().getResponse<HeaderSettableResponse>(),
            error.retryAfterSec,
          )
        }
        throw error
      }),
    )
  }
}
