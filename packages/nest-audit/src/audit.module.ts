/**
 * `AuditModule`：装配 {@link AuditService} 与 {@link AuditInterceptor}（蓝图 §4.8）。
 *
 * @packageDocumentation
 */

import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { AuditInterceptor } from './audit.interceptor'
import { AuditService } from './audit.service'

/**
 * 审计模块。
 *
 * `forRoot()` 只注册 `AuditService` / `AuditInterceptor` 两个 provider，**不**把拦截器
 * 接进 `APP_INTERCEPTOR`——守卫链/拦截器链的顺序在 `apps/api/src/bootstrap/app.module.ts`
 * （T0-8）一处定死（蓝图 §4.3：`GlobalAuthGuard → PermissionsGuard → BillingGateGuard →
 * DataScopeInterceptor → AuditInterceptor`），本包不该替它做主。
 *
 * `@Global()`：`AuditService` 是横切依赖（几乎每个写操作的 service 都可能手动补一条审计），
 * 逐个 `imports: [AuditModule]` 纯属噪音，与 `CoreModule` / `PrismaModule` 的取舍一致。
 *
 * @example
 * ```ts
 * // apps/api/src/bootstrap/app.module.ts
 * @Module({
 *   imports: [CoreModule.forRoot(...), PrismaModule.forRoot(...), AuditModule.forRoot()],
 *   providers: [
 *     { provide: APP_GUARD, useClass: GlobalAuthGuard },
 *     { provide: APP_GUARD, useClass: PermissionsGuard },
 *     { provide: APP_GUARD, useClass: BillingGateGuard },
 *     { provide: APP_INTERCEPTOR, useClass: DataScopeInterceptor },
 *     provideAuditInterceptor(), // 必须排在最后一个
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class AuditModule {
  static forRoot(): DynamicModule {
    return {
      module: AuditModule,
      providers: [AuditService, AuditInterceptor],
      exports: [AuditService, AuditInterceptor],
    }
  }
}

/**
 * 便捷 provider：`{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }`。
 *
 * 供 T0-8 直接 spread 进自己按顺序排好的 `APP_INTERCEPTOR` provider 数组，
 * 不必自己重写这一行。
 */
export function provideAuditInterceptor(): Provider {
  return { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }
}
