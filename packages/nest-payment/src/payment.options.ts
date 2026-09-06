/**
 * `PaymentModule.forRoot()` 的选项与默认值。
 *
 * @packageDocumentation
 */

import type { CredentialVault } from '@taizan/crypto'
import type { FakeProviderOptions, PayChannel, PaymentProvider } from '@taizan/payment-core'

import type { ChannelAckSpec } from './callback-ack'
import type { PaymentLogger } from './logging'
import type { ProviderConfigResolver } from './provider.registry'

/** 统一回调控制器的路由前缀（蓝图 §4.12 定死）。 */
export const PAY_NOTIFY_ROUTE_PREFIX = 'api/public/pay'

/** 幂等作用域。键是 `transactionId`。 */
export const PAY_CALLBACK_IDEMPOTENCY_SCOPE = 'pay:callback'

/** 退款回调的幂等作用域。键是 `outRefundNo`——一笔支付可以退多次，用 txnId 会吞掉第二次。 */
export const REFUND_CALLBACK_IDEMPOTENCY_SCOPE = 'pay:refund-callback'

/** 退款单号的默认前缀，`buildOutTradeNo('RFD')` 产出 `RFD-<ULID>`。 */
export const REFUND_NO_PREFIX = 'RFD'

/** {@link PaymentModule.forRoot} 的选项。 */
export interface PaymentModuleOptions {
  /**
   * 装配的 Provider **实例**（不是类）。
   *
   * Provider 是无状态的，全进程一个实例服务所有租户；租户差异全在
   * `ProviderConfig` 里，由 {@link PaymentModuleOptions.configResolver} 现取。
   */
  providers?: readonly PaymentProvider[]

  /** 配置解析器。不传时用 `DbProviderConfigResolver`（`TenantCredential` + `PlatformSetting`）。 */
  configResolver?: ProviderConfigResolver

  /**
   * 装一个 `FakeProvider` 并暴露 `FakePaymentTestKit`（e2e / 本地开发用）。
   *
   * **生产开这个开关就是配置事故**：它会让「假回调」直接兑现真权益。
   * `apps/api` 应该把它接到 `assertNoDevCodeInProd` 的开关清单里。
   */
  useFake?: boolean

  /** `useFake: true` 时传给 `FakeProvider` 的参数（渠道、签名 secret）。 */
  fake?: FakeProviderOptions

  /** api 对外基址，用于拼 notifyUrl。不传时读 `ConfigService.get('API_BASE_URL')`。 */
  apiBaseUrl?: string

  /** 解密租户级商户密钥用的 vault。用自己的 `configResolver` 时可以不传。 */
  vault?: CredentialVault

  /** 日志器。不传用 Nest 自带的 `Logger`。 */
  logger?: PaymentLogger

  /** 覆盖某个渠道的应答报文（见 `callback-ack.ts`）。 */
  acks?: Partial<Record<PayChannel, ChannelAckSpec>>

  /** 幂等留痕时长（秒）。默认走 `IdempotencyService` 的 24 小时。 */
  idempotencyTtlSec?: number

  /**
   * 注册统一回调控制器，默认 `true`。
   *
   * 置 `false` 的唯一正当场景是「只想用 `PaymentService` 下单，回调由别的进程收」。
   */
  registerController?: boolean

  /**
   * 回调地址里携带租户 id 的查询参数名，默认 `tenant`。
   *
   * 商家自己收款时，验签用的是**商家自己的** apiV3Key，而验签必须发生在解析报文之前——
   * 也就是说控制器必须在「还没解开报文」的时候就知道是哪家店。所以下单时把租户写进
   * notifyUrl 的查询串，回调原样带回来。这正是蓝图 §8 第 3 条说的
   * 「支付回调按参数定位租户」那一处合法 raw 用途。
   *
   * 平台自身收款（套餐订单）不带这个参数，走 `PlatformSetting` 里的平台商户号。
   */
  tenantQueryParam?: string
}

/** 填好默认值之后的选项。 */
export interface NormalizedPaymentOptions {
  useFake: boolean
  registerController: boolean
  tenantQueryParam: string
  idempotencyTtlSec: number | undefined
  acks: Partial<Record<PayChannel, ChannelAckSpec>>
}

/** 填默认值。 */
export function normalizePaymentOptions(
  options: PaymentModuleOptions = {},
): NormalizedPaymentOptions {
  return {
    useFake: options.useFake ?? false,
    registerController: options.registerController ?? true,
    tenantQueryParam: options.tenantQueryParam ?? 'tenant',
    idempotencyTtlSec: options.idempotencyTtlSec,
    acks: options.acks ?? {},
  }
}
