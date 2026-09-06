/**
 * 本包所有注入 token 的单一真源。
 *
 * 为什么用 `Symbol.for` 而不是字符串：`Symbol.for('x')` 在全局注册表里按 key 复用同一个
 * symbol，所以就算 esm 与 cjs 两份产物同时被加载（monorepo 里很常见），拿到的仍是同一个
 * token，注入不会莫名其妙解析不到；同时又不像裸字符串那样可能和别人撞名。
 *
 * @packageDocumentation
 */

/** Redis 客户端注入 token，见 {@link AuthRedis}。 */
export const AUTH_REDIS = Symbol.for('@taizan/nest-auth:AUTH_REDIS')

/** {@link AuthModuleOptions} 归一化之后的配置对象。 */
export const AUTH_OPTIONS = Symbol.for('@taizan/nest-auth:AUTH_OPTIONS')

/** {@link TokenTtlConfig} 的注入 token。 */
export const AUTH_TTL = Symbol.for('@taizan/nest-auth:AUTH_TTL')

/** `MembershipProvider` 的注入 token（接口没有运行时值，只能用 token）。 */
export const MEMBERSHIP_PROVIDER = Symbol.for('@taizan/nest-auth:MEMBERSHIP_PROVIDER')

/** `TenantResolverStrategy[]` 的注入 token。 */
export const TENANT_RESOLVERS = Symbol.for('@taizan/nest-auth:TENANT_RESOLVERS')

/** 可注入的时钟（测试里推进时间用），见 {@link Clock}。 */
export const AUTH_CLOCK = Symbol.for('@taizan/nest-auth:AUTH_CLOCK')

/** {@link ConcurrencyLimits} 的注入 token（各 kind 允许同时在线的端数）。 */
export const AUTH_CONCURRENCY = Symbol.for('@taizan/nest-auth:AUTH_CONCURRENCY')

/** 限流计数 store（`@taizan/ratelimit-core` 的 `RateLimitStore`）的注入 token。 */
export const RATE_LIMIT_STORE = Symbol.for('@taizan/nest-auth:RATE_LIMIT_STORE')

/** {@link RateLimitRuntimeOptions} 的注入 token（key 前缀、降级日志限频）。 */
export const RATE_LIMIT_OPTIONS = Symbol.for('@taizan/nest-auth:RATE_LIMIT_OPTIONS')
