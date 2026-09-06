/**
 * 装配入口。
 *
 * @packageDocumentation
 */

import {
  type DynamicModule,
  Global,
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Provider,
  RequestMethod,
} from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { assertFeatureNotShadowingRenewal } from '@taizan/billing-rules'
import { systemClock } from '@taizan/nest-auth'
import { BillingGateGuard } from './billing-gate.guard'
import {
  readEnforceFromEnv,
  type BillingModuleOptions,
  type ResolvedBillingOptions,
} from './billing.options'
import { ConsumeQuotaInterceptor } from './consume-quota.decorator'
import { PrismaPlatformGateway } from './platform-gateway'
import { QuotaService } from './quota.service'
import { CLIENT_GATE_PREFIXES, TenantGateMiddleware } from './tenant-gate.middleware'
import {
  BILLING_CLOCK,
  BILLING_FEATURES,
  BILLING_OPTIONS,
  GATEWAY_OPTIONS,
  PLATFORM_GATEWAY,
} from './tokens'

/**
 * 把 {@link BillingGateGuard} 摆进守卫链的助手。
 *
 * ```ts
 * providers: [
 *   { provide: APP_GUARD, useExisting: GlobalAuthGuard },   // 1
 *   { provide: APP_GUARD, useExisting: PermissionsGuard },  // 2
 *   provideBillingGateGuard(),                              // 3
 * ]
 * ```
 *
 * `useExisting` 而不是 `useClass`：后者会 new 出第二个实例，
 * 那个实例注入的是同一批依赖，行为上看不出差别，但任何实例状态（缓存、去重集合）
 * 都会各记各的。守卫是单例这件事得写死。
 */
export function provideBillingGateGuard(): Provider {
  return { provide: APP_GUARD, useExisting: BillingGateGuard }
}

/**
 * 计费闸门模块（T1-4）。
 *
 * ## 一次 `forRoot()` 接好这些
 *
 * - `PlatformGateway`（查库实现 + 30 秒缓存 + `invalidate`）；
 * - `BillingGateGuard`（**默认不注册成 APP_GUARD**，用 {@link provideBillingGateGuard}）；
 * - `TenantGateMiddleware`（**默认不挂**，见 `registerClientMiddleware`）；
 * - `QuotaService` 与 `@ConsumeQuota()` 的拦截器；
 * - 启动时校验功能开关没有遮蔽续费白名单。
 *
 * ## 前置条件
 *
 * 必须在 `CoreModule.forRoot()`（要 `AppLogger` / ALS 上下文）与
 * `PrismaModule.forRoot()`（要 `PrismaService`）**之后**导入。
 *
 * ## `@Global()` 的理由
 *
 * `QuotaService` 会出现在几乎每个「新建点什么」的业务模块里，
 * 让它们逐个 `imports: [BillingModule]` 是纯噪音。
 */
@Global()
@Module({})
export class BillingModule implements NestModule {
  static forRoot(options: BillingModuleOptions): DynamicModule {
    const {
      features,
      enforce,
      gateway,
      clock = systemClock,
      gatewayOptions,
      registerGlobalGuard = false,
      registerClientMiddleware = false,
    } = options

    // 启动即失败。放到第一次请求再查的话，发现「商家续不了费」的是商家。
    // 这条断言与 spec 8（`billing-routes.spec.ts`）的另一半互为补充：
    // 那边扫源码，这边在真实装配时拿真实注册表再判一次。
    assertFeatureNotShadowingRenewal(features)

    const resolved: ResolvedBillingOptions = {
      enforce: enforce ?? readEnforceFromEnv(),
      registerClientMiddleware,
    }

    const gatewayDef: Provider = gateway
      ? { provide: PLATFORM_GATEWAY, useValue: gateway }
      : { provide: PLATFORM_GATEWAY, useExisting: PrismaPlatformGateway }

    const providers: Provider[] = [
      { provide: BILLING_OPTIONS, useValue: resolved },
      { provide: BILLING_FEATURES, useValue: features },
      { provide: BILLING_CLOCK, useValue: clock },
      { provide: GATEWAY_OPTIONS, useValue: gatewayOptions ?? {} },
      // 即使下游换了 gateway，查库实现也照样注册——它很便宜（构造函数只存几个引用），
      // 而少一个可选分支就少一处「为什么这里注入不到」的排查。
      PrismaPlatformGateway,
      gatewayDef,
      QuotaService,
      BillingGateGuard,
      TenantGateMiddleware,
      ConsumeQuotaInterceptor,
      { provide: APP_INTERCEPTOR, useExisting: ConsumeQuotaInterceptor },
    ]

    if (registerGlobalGuard) providers.push(provideBillingGateGuard())

    return {
      module: BillingModule,
      providers,
      exports: [
        BILLING_OPTIONS,
        BILLING_FEATURES,
        BILLING_CLOCK,
        PLATFORM_GATEWAY,
        PrismaPlatformGateway,
        QuotaService,
        BillingGateGuard,
        TenantGateMiddleware,
      ],
    }
  }

  constructor(@Inject(BILLING_OPTIONS) private readonly options: ResolvedBillingOptions) {}

  /**
   * 挂 C 端闸门。
   *
   * `forRoutes` 的入参直接来自 {@link CLIENT_GATE_PREFIXES} 常量——手抄一份字符串
   * 就会有一天漏掉一个前缀，而漏掉的表现是「那批接口在到期店铺上照常能用」，
   * 没有任何报错。
   */
  configure(consumer: MiddlewareConsumer): void {
    if (!this.options.registerClientMiddleware) return

    consumer.apply(TenantGateMiddleware).forRoutes(
      // 与 nest-core / nest-auth 一致：Nest 11 底下是 Express 5 + path-to-regexp 8，
      // 裸 '*' 会被当成非法路径参数报 Missing parameter name。
      ...CLIENT_GATE_PREFIXES.flatMap((prefix) => [
        { path: prefix, method: RequestMethod.ALL },
        { path: `${prefix}/*path`, method: RequestMethod.ALL },
      ]),
    )
  }
}

/** 重新导出，省得下游为了 `forRoutes` 再 import 一次中间件文件。 */
export { CLIENT_GATE_PREFIXES }
