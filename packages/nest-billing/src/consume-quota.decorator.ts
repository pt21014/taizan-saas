/**
 * `@ConsumeQuota('STAFF')`：把「先占配额，业务失败就还回去」这段样板收成一行。
 *
 * ```ts
 * @Post()
 * @ConsumeQuota('STAFF')
 * create(@Body() dto: CreateStaffDto) { … }
 * ```
 *
 * ## 顺序：先占，失败再还
 *
 * 直觉上「建完再计数」更自然，但那样**判不出超限**——等业务把第 4 个员工建完了
 * 才发现套餐只给 3 个，那一行已经在库里了，删也不是留也不是。所以是：
 * 进 handler 之前 `consume`（超了直接 `1540301`，业务代码根本不跑），
 * handler 抛错时 `release` 还回去。
 *
 * ## 它的代价，以及什么时候别用
 *
 * 拦截器扣配额与业务写库**不在同一个事务里**。进程在两者之间被 kill，计数会虚高一格。
 * 对「员工数」「门店数」这种小数目、且有平台侧纠偏脚本兜底的维度，这个代价可以接受；
 * 对钱、对按量计费的维度，别用装饰器，老老实实在事务里调
 * {@link QuotaService.consume} 并把 `tx` 传进去。
 *
 * @packageDocumentation
 */

import {
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  type CallHandler,
  type CustomDecorator,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AppLogger } from '@taizan/nest-core'
import type { Observable } from 'rxjs'
import { catchError, from, switchMap, throwError } from 'rxjs'
import { QuotaService } from './quota.service'

/** 元数据 key。 */
export const CONSUME_QUOTA_KEY = 'taizan:consume-quota'

/** `@ConsumeQuota()` 挂上去的元数据。 */
export interface ConsumeQuotaMeta {
  kind: string
  delta: number
}

/**
 * 声明「这个路由要占一份配额」。
 *
 * @param kind - `QuotaKind` 枚举值
 * @param delta - 占几个，默认 1
 */
export function ConsumeQuota(kind: string, delta = 1): CustomDecorator<string> {
  return SetMetadata<string, ConsumeQuotaMeta>(CONSUME_QUOTA_KEY, { kind, delta })
}

/**
 * 兑现 {@link ConsumeQuota} 的拦截器。
 *
 * 由 `BillingModule` 注册为 `APP_INTERCEPTOR`——它对没打装饰器的路由是零开销
 * （读一次 metadata 就返回），比让每个模块各自 `@UseInterceptors` 少一处漏挂。
 */
@Injectable()
export class ConsumeQuotaInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<ConsumeQuotaMeta | undefined>(CONSUME_QUOTA_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (meta === undefined) return next.handle()

    return from(this.quota.consume(meta.kind, meta.delta)).pipe(
      switchMap(() =>
        next.handle().pipe(
          catchError((error: unknown) => {
            // 业务失败，把刚占的还回去。还的过程再失败也只记日志：
            // 让「归还失败」盖掉业务的真实错误，排查时会指错方向。
            void this.quota.release(meta.kind, meta.delta).catch((releaseError: unknown) => {
              this.logger?.error(
                `配额归还失败（业务已失败，计数可能虚高 ${String(meta.delta)}）：kind=${meta.kind}`,
                releaseError instanceof Error ? releaseError.stack : undefined,
                'BillingQuota',
              )
            })
            return throwError(() => error)
          }),
        ),
      ),
    )
  }
}
