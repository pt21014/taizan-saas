/**
 * `PaymentModule`：把 Provider、配置解析、统一回调控制器、下单编排接起来。
 *
 * @example
 * ```ts
 * // apps/api/src/bootstrap/app.module.ts
 * PaymentModule.forRoot({
 *   providers: [new WechatPayProvider({ api: wechatPayApi })],
 *   vault: createVault({ keys: JSON.parse(env.CRYPTO_KEYS), currentKeyId: env.CRYPTO_KEY_CURRENT }),
 *   logger: appLogger,
 *   useFake: env.PAY_FAKE_ENABLED,   // 生产必须为 false，接进 assertNoDevCodeInProd
 * })
 * ```
 *
 * `@Global()` 的理由与 `PrismaModule` / `InfraModule` 相同：`PaymentService` 是横切依赖，
 * 让每个能收钱的业务模块逐个 `imports: [PaymentModule]` 纯属噪音。
 *
 * ## 它依赖谁
 *
 * - `@taizan/nest-infra` 的 `IdempotencyService`（**必需**，回调幂等就是它）；
 * - `@taizan/nest-prisma` 的 `PrismaService`（只有默认的 `DbProviderConfigResolver` 要，
 *   自带 `configResolver` 时可以完全不装）；
 * - `@taizan/nest-audit` 的 `AuditService`（可选，没装就不记审计）；
 * - `@taizan/nest-core` 的 `ConfigService`（可选，用来读 `API_BASE_URL`；
 *   也可以直接传 `apiBaseUrl`）。
 *
 * @packageDocumentation
 */

import {
  Global,
  Inject,
  Logger,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationBootstrap,
  type Provider,
} from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { ConfigService } from '@taizan/nest-core'
import type { PaymentProvider } from '@taizan/payment-core'

import { createFakePaymentProvider, FakePaymentTestKit } from './fake.provider'
import { PaymentHandlerRegistry } from './handlers'
import type { PaymentLogger } from './logging'
import { PaymentNotifyController } from './notify.controller'
import {
  normalizePaymentOptions,
  type NormalizedPaymentOptions,
  type PaymentModuleOptions,
} from './payment.options'
import { PaymentService } from './payment.service'
import {
  DbProviderConfigResolver,
  ProviderRegistry,
  StaticProviderConfigResolver,
  type ProviderConfigResolver,
} from './provider.registry'
import {
  FAKE_PAYMENT_PROVIDER,
  PAYMENT_API_BASE_URL,
  PAYMENT_CREDENTIAL_VAULT,
  PAYMENT_LOGGER,
  PAYMENT_OPTIONS,
  PAYMENT_PROVIDERS,
  PROVIDER_CONFIG_RESOLVER,
} from './tokens'

@Global()
@Module({})
export class PaymentModule implements OnApplicationBootstrap {
  constructor(
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(PaymentHandlerRegistry) private readonly handlers: PaymentHandlerRegistry,
    @Inject(PAYMENT_OPTIONS) private readonly options: NormalizedPaymentOptions,
    @Optional() @Inject(PAYMENT_LOGGER) private readonly logger?: PaymentLogger,
  ) {}

  static forRoot(options: PaymentModuleOptions = {}): DynamicModule {
    const normalized = normalizePaymentOptions(options)
    const logger: PaymentLogger = options.logger ?? new Logger('PaymentModule')

    const fake = normalized.useFake ? createFakePaymentProvider(options.fake ?? {}) : undefined
    const providerInstances: PaymentProvider[] = [...(options.providers ?? [])]
    if (fake) {
      // 放在末尾：显式装配的真 Provider 优先占住渠道，Fake 撞车时 ProviderRegistry 会抛，
      // 这正是我们要的——「生产误开 useFake」应该启动即炸，而不是静默顶掉真渠道。
      providerInstances.push(fake)
    }

    const providers: Provider[] = [
      { provide: PAYMENT_OPTIONS, useValue: normalized },
      { provide: PAYMENT_LOGGER, useValue: logger },
      { provide: PAYMENT_PROVIDERS, useValue: providerInstances },
      { provide: PAYMENT_CREDENTIAL_VAULT, useValue: options.vault ?? null },
      {
        provide: PAYMENT_API_BASE_URL,
        // ConfigService 是可选依赖：只用 PaymentService 的下游项目可能压根没装 CoreModule。
        useFactory: (config?: ConfigService): string =>
          options.apiBaseUrl ?? (config?.get('API_BASE_URL') as string | undefined) ?? '',
        inject: [{ token: ConfigService, optional: true }],
      },
      resolverProvider(options, normalized),
      ProviderRegistry,
      PaymentHandlerRegistry,
      PaymentService,
    ]

    const exported: NonNullable<DynamicModule['exports']> = [
      PAYMENT_OPTIONS,
      PAYMENT_API_BASE_URL,
      PROVIDER_CONFIG_RESOLVER,
      ProviderRegistry,
      PaymentHandlerRegistry,
      PaymentService,
    ]

    if (fake) {
      providers.push({ provide: FAKE_PAYMENT_PROVIDER, useValue: fake }, FakePaymentTestKit)
      exported.push(FAKE_PAYMENT_PROVIDER, FakePaymentTestKit)
    }

    return {
      module: PaymentModule,
      // DiscoveryModule 供 PaymentHandlerRegistry 扫 @PaymentHandler。
      imports: [DiscoveryModule],
      controllers: normalized.registerController ? [PaymentNotifyController] : [],
      providers,
      exports: exported,
    }
  }

  /**
   * 启动自检：把「装了哪些渠道、认领了哪些前缀」打出来。
   *
   * 支付这条链路最典型的故障是「什么都没发生」——回调进来了、路由不到、没人报错。
   * 启动日志里有这一行，排障时第一眼就能看出是装配问题还是报文问题。
   */
  onApplicationBootstrap(): void {
    const channels = this.providers.channels()
    const prefixes = this.handlers.prefixes()
    this.logger?.log?.(
      `[@taizan/nest-payment] 渠道 [${channels.join(', ') || '无'}]；` +
        `outTradeNo 前缀 [${prefixes.join(', ') || '无'}]` +
        `${this.options.useFake ? '；已启用 FakeProvider（生产环境必须关闭）' : ''}`,
      'PaymentModule',
    )
    if (channels.length > 0 && prefixes.length === 0) {
      this.logger?.warn?.(
        '[@taizan/nest-payment] 装了支付渠道却一个 @PaymentHandler 都没有：' +
          '回调进来会被记 error 并直接应答成功，钱到账但不会被兑现',
        'PaymentModule',
      )
    }
  }
}

/**
 * 配置解析器的三档回退：显式传的 → `useFake` 时的空配置 → 读库的默认实现。
 *
 * `useFake` 那一档很重要：e2e 不该为了跑通一次支付而去 seed 一张 `TenantCredential`。
 */
function resolverProvider(
  options: PaymentModuleOptions,
  normalized: NormalizedPaymentOptions,
): Provider {
  if (options.configResolver) {
    return { provide: PROVIDER_CONFIG_RESOLVER, useValue: options.configResolver }
  }
  if (normalized.useFake) {
    const empty: ProviderConfigResolver = new StaticProviderConfigResolver()
    return { provide: PROVIDER_CONFIG_RESOLVER, useValue: empty }
  }
  return { provide: PROVIDER_CONFIG_RESOLVER, useClass: DbProviderConfigResolver }
}
