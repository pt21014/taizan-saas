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
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core'
import type { DestinationStream } from 'pino'
import type { z } from 'zod'
import { assertNoDevCodeInProd, warnIfBillingNotEnforcedInProd } from './config/assert-no-dev-code'
import { ConfigService, ENV } from './config/config.service'
import { loadEnv } from './config/define-env'
import { BASE_ENV_SCHEMA, type BaseEnv } from './config/env.schema'
import { ContextMiddleware } from './context/context.middleware'
import { IP_RESOLVER, type IpResolver } from './context/ip-resolver'
import { HealthController, HEALTH_VERSION } from './health/health.controller'
import {
  HealthCounters,
  HEALTH_INDICATORS,
  HealthRegistry,
  type HealthIndicator,
} from './health/indicators'
import { AllExceptionsFilter } from './http/all-exceptions.filter'
import { TransformInterceptor } from './http/transform.interceptor'
import { LoggerModule } from './logging/logger.module'
import { AppLogger } from './logging/logger.service'

/** {@link CoreModule.forRoot} 的选项。 */
export interface CoreModuleOptions {
  /**
   * env schema。默认 {@link BASE_ENV_SCHEMA}；业务项目传 `defineEnvSchema(BASE_ENV_SCHEMA, {...})`
   * 的产物，`ConfigService<AppEnv>` 就能拿到扩展字段的类型。
   */
  envSchema?: z.ZodTypeAny
  /** env 原始来源，默认 `process.env`。测试里传对象字面量。 */
  envSource?: Record<string, string | undefined>
  /** 静态注册的健康探针。DB/Redis 探针由下游包用 {@link HealthRegistry} 动态注册。 */
  healthIndicators?: readonly HealthIndicator[]
  /** `/health` 里回的版本号，通常传 `package.json` 的 version。 */
  version?: string
  /** 日志输出目标。测试里传内存流即可断言日志内容。 */
  logDestination?: DestinationStream
  /** 是否注册 `HealthController`，默认 `true`。 */
  registerHealthController?: boolean
  /** 追加的 provider（下游包用来注入自己的探针实现等）。 */
  extraProviders?: Provider[]
  /**
   * `ctx.ip` 的解析器（见 `context/ip-resolver.ts`）。
   *
   * **通常不用传**：装了 `AuthModule.forRoot` 的进程会以全局 provider 的形式
   * 把 `resolveIps` 的适配器注册到 {@link IP_RESOLVER}，`ContextMiddleware` 自动就能拿到。
   * 这个选项是给「不装 nest-auth 但又要真实客户端 IP」的进程用的（比如只跑队列消费者的那种）。
   *
   * 两边都提供时**以这里为准**：`ContextMiddleware` 属于 `CoreModule`，
   * 本模块自己的 provider 优先于全局模块导出的同名 token。
   */
  ipResolver?: IpResolver
}

/**
 * 框架基座模块（蓝图 T0-5）。
 *
 * 一次 `forRoot()` 把这些全部接好：
 * - env 校验（失败中文报错、启动即失败）+ 生产后门开关拒启；
 * - pino 日志（每行带 traceId、自动脱敏）；
 * - `ContextMiddleware`（AsyncLocalStorage 上下文 + `X-Trace-Id` 回写）；
 * - 全局 `AllExceptionsFilter` 与 `TransformInterceptor`（统一信封 + `@RawResponse()` 逃生口）；
 * - `GET /health`。
 *
 * helmet / CORS / Swagger **不在这里**——它们要拿到 `INestApplication` 实例，
 * 属于 `main.ts` 的 bootstrap 阶段，用 `applyHelmet` / `applyCors` / `setupSwagger` 三个函数装配。
 *
 * `@Global()`：`ConfigService` 和 `AppLogger` 是每个模块都要用的横切依赖，
 * 让业务模块逐个 `imports: [CoreModule]` 纯属噪音。
 */
@Global()
@Module({})
export class CoreModule implements NestModule {
  static forRoot(options: CoreModuleOptions = {}): DynamicModule {
    const {
      envSchema = BASE_ENV_SCHEMA,
      envSource = process.env,
      healthIndicators = [],
      version = '0.0.0',
      logDestination,
      registerHealthController = true,
      extraProviders = [],
      ipResolver,
    } = options

    // 顺序有讲究：先校验 env（缺字段就没必要往下走），再查后门开关。
    const env = loadEnv(envSchema, envSource) as BaseEnv
    assertNoDevCodeInProd(env as unknown as Record<string, unknown>)

    const registryProvider: Provider = {
      provide: HealthRegistry,
      useFactory: (indicators?: readonly HealthIndicator[]) => {
        const registry = new HealthRegistry()
        registry.registerAll(indicators ?? healthIndicators)
        return registry
      },
      inject: [{ token: HEALTH_INDICATORS, optional: true }],
    }

    return {
      module: CoreModule,
      imports: [
        LoggerModule.forRoot({
          level: env.LOG_LEVEL,
          ...(logDestination ? { destination: logDestination } : {}),
        }),
      ],
      controllers: registerHealthController ? [HealthController] : [],
      providers: [
        { provide: ENV, useValue: env },
        ConfigService,
        { provide: 'TAIZAN_IS_PRODUCTION', useValue: env.NODE_ENV === 'production' },
        { provide: HEALTH_VERSION, useValue: version },
        HealthCounters,
        registryProvider,
        ContextMiddleware,
        // 只在显式传了的时候才注册：不注册的话这个 token 由 AuthModule（@Global）提供，
        // 注册了就把它挡住了。
        ...(ipResolver ? [{ provide: IP_RESOLVER, useValue: ipResolver }] : []),
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
        ...extraProviders,
      ],
      exports: [ENV, ConfigService, HealthRegistry, HealthCounters, HEALTH_VERSION],
    }
  }

  constructor(
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(ENV) private readonly env: BaseEnv,
  ) {}

  configure(consumer: MiddlewareConsumer): void {
    // `{ path: '*', method: ALL }` 而不是字符串 `'*'`：Nest 11 底下是 Express 5 + path-to-regexp 8，
    // 裸 `'*'` 会被当成非法路径参数报 `Missing parameter name`。
    consumer.apply(ContextMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL })
  }

  onModuleInit(): void {
    const warning = warnIfBillingNotEnforcedInProd(this.env as unknown as Record<string, unknown>)
    if (warning) {
      this.logger.warn(warning, 'CoreModule')
    }
  }
}
