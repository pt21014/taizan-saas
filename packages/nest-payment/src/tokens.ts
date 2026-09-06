/**
 * 注入 token。
 *
 * 全部用 `Symbol.for()`：同一个包在 monorepo 里被解析成两份实例时（pnpm 的
 * 幽灵依赖、或 ESM/CJS 双份产物），`Symbol.for` 是全局注册表里的同一个符号，
 * 而 `Symbol()` 会是两个——表现为「明明 provide 了却 Nest can't resolve」。
 *
 * @packageDocumentation
 */

/** 归一化后的 {@link import('./payment.module').PaymentModuleOptions}。 */
export const PAYMENT_OPTIONS = Symbol.for('@taizan/nest-payment:OPTIONS')

/** 装配进来的 `PaymentProvider` 实例数组。 */
export const PAYMENT_PROVIDERS = Symbol.for('@taizan/nest-payment:PROVIDERS')

/** {@link import('./provider.registry').ProviderConfigResolver} 实现。 */
export const PROVIDER_CONFIG_RESOLVER = Symbol.for('@taizan/nest-payment:CONFIG_RESOLVER')

/**
 * `@taizan/crypto` 的 `CredentialVault`。
 *
 * 本包**只消费**它，不负责建（密钥来自 env，建 vault 是 `apps/api` bootstrap 的事）。
 */
export const PAYMENT_CREDENTIAL_VAULT = Symbol.for('@taizan/nest-payment:VAULT')

/** 回调地址与下单用的 api 基址（`API_BASE_URL`）。 */
export const PAYMENT_API_BASE_URL = Symbol.for('@taizan/nest-payment:API_BASE_URL')

/** 日志器，见 {@link import('./logging').PaymentLogger}。 */
export const PAYMENT_LOGGER = Symbol.for('@taizan/nest-payment:LOGGER')

/** `useFake: true` 时装配进来的 `FakeProvider` 实例。 */
export const FAKE_PAYMENT_PROVIDER = Symbol.for('@taizan/nest-payment:FAKE_PROVIDER')
