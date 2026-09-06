/**
 * 本包所有注入 token 的单一真源。
 *
 * 用 `Symbol.for` 的理由与 `@taizan/nest-auth/src/tokens.ts` 一致：全局注册表按 key 复用
 * 同一个 symbol，esm 与 cjs 两份产物同时被加载时注入仍然解析得到，又不会像裸字符串
 * 那样撞名。
 *
 * @packageDocumentation
 */

/** {@link BillingModuleOptions} 归一化之后的配置对象。 */
export const BILLING_OPTIONS = Symbol.for('@taizan/nest-billing:BILLING_OPTIONS')

/**
 * 功能开关注册表（`readonly FeatureDef[] | null`）的注入 token。
 *
 * 这是**平台侧的功能目录**（有哪些功能项、各自盖住哪些路径前缀），
 * 与租户实际买到的 `Plan.features`（`string[] | null`）不是一回事。
 */
export const BILLING_FEATURES = Symbol.for('@taizan/nest-billing:BILLING_FEATURES')

/** `PlatformGateway` 的注入 token（接口没有运行时值，只能用 token）。 */
export const PLATFORM_GATEWAY = Symbol.for('@taizan/nest-billing:PLATFORM_GATEWAY')

/** 可注入的时钟（测试里推进时间用），见 `@taizan/nest-auth` 的 `Clock`。 */
export const BILLING_CLOCK = Symbol.for('@taizan/nest-billing:BILLING_CLOCK')

/** {@link PlatformGatewayOptions} 的注入 token（缓存时长、租户配额覆盖加载器）。 */
export const GATEWAY_OPTIONS = Symbol.for('@taizan/nest-billing:GATEWAY_OPTIONS')
