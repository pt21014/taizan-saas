/**
 * `@taizan/nest-payment`：支付的 Nest 装配层（蓝图 §4.12）。
 *
 * 协议层在 `@taizan/payment-core`（接口 + `FakeProvider`）与 `@taizan/wechatpay`
 * （微信实现）；本包只负责在 Nest 里把它们接起来，并提供**唯一**的回调入口：
 *
 * ```
 * POST /api/public/pay/:channel/notify          验签 → 幂等(transactionId) → 归一化 → 按前缀路由
 * POST /api/public/pay/:channel/refund-notify   验签 → 幂等(outRefundNo)   → 归一化 → 按前缀路由
 * ```
 *
 * 三条不可退让：
 *
 * 1. **验签不过的回调一个字节都不落库**，也不进幂等表——没验签之前每个字段都是攻击者写的；
 * 2. **幂等键是 `transactionId`**，渠道必然重推，去重不该由每个领域各写一遍；
 * 3. **本包不注入租户上下文**。回调没有 token，`tenantId` 由领域处理器按 `outTradeNo`
 *    查订单后自行确定（`prisma.raw` + `// raw-reason: 支付回调按参数定位租户`，蓝图 §8 第 3 条）。
 *
 * @packageDocumentation
 */

// ── 装配 ────────────────────────────────────────────────────────────────
export { PaymentModule } from './payment.module'
export {
  normalizePaymentOptions,
  PAY_CALLBACK_IDEMPOTENCY_SCOPE,
  PAY_NOTIFY_ROUTE_PREFIX,
  REFUND_CALLBACK_IDEMPOTENCY_SCOPE,
  REFUND_NO_PREFIX,
  type NormalizedPaymentOptions,
  type PaymentModuleOptions,
} from './payment.options'
export {
  FAKE_PAYMENT_PROVIDER,
  PAYMENT_API_BASE_URL,
  PAYMENT_CREDENTIAL_VAULT,
  PAYMENT_LOGGER,
  PAYMENT_OPTIONS,
  PAYMENT_PROVIDERS,
  PROVIDER_CONFIG_RESOLVER,
} from './tokens'
export type { PaymentLogger } from './logging'

// ── Provider 与配置 ─────────────────────────────────────────────────────
export {
  CHANNEL_CREDENTIAL_PROVIDER,
  DbProviderConfigResolver,
  platformSettingPrefix,
  ProviderRegistry,
  StaticProviderConfigResolver,
  type DbProviderConfigResolverOptions,
  type ProviderConfigResolver,
} from './provider.registry'

// ── 回调 ────────────────────────────────────────────────────────────────
export { parseChannel, PaymentNotifyController, readRawCallback } from './notify.controller'
export {
  ackSpecOf,
  DEFAULT_CHANNEL_ACKS,
  type CallbackAck,
  type ChannelAckSpec,
} from './callback-ack'

// ── 领域处理器 ──────────────────────────────────────────────────────────
export {
  getPaymentHandlerPrefix,
  PAYMENT_HANDLER_METADATA,
  PaymentHandler,
  PaymentHandlerRegistry,
  type PaymentEventHandler,
} from './handlers'

// ── 编排 ────────────────────────────────────────────────────────────────
export {
  PaymentService,
  type CreateOrderParams,
  type QueryOrderParams,
  type RefundOutcome,
  type RefundParams,
} from './payment.service'

// ── e2e ─────────────────────────────────────────────────────────────────
export {
  createFakePaymentProvider,
  FakePaymentTestKit,
  type SimulatedCallbackResponse,
} from './fake.provider'
