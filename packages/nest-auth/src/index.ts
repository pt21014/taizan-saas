/**
 * `@taizan/nest-auth`：三套身份认证与守卫（蓝图 §4.1、§4.3）。
 *
 * ## 三条不变量（改这个包之前先读这三条）
 *
 * 1. **默认拒绝**。`GlobalAuthGuard` 装成 `APP_GUARD`，一个什么装饰器都不写的新控制器
 *    的行为是 401。公开必须显式 `@Public()`，且必须同时 `@RateLimited(tier)`。
 * 2. **staff token 一次只绑一家店**。`tenantId` 只来自 token，不读任何请求参数；
 *    换店走 `AuthFlowService.switchTenant` 重签（**不吊销旧 token**，取舍写在那个方法的
 *    TSDoc 里）。`/api/admin/*` 因此被列进 `TENANT_TOKEN_ONLY_PREFIXES`：中间件在那里
 *    只跑 token 策略，且解析不到时**留空不抛错**，让守卫去报 1140100 而不是 1240400。
 * 3. **库里的角色覆盖 token 里的**。staff 每请求现查 `MembershipProvider`（30 秒缓存），
 *    membership 为空或 status ≠ ACTIVE 直接 401；`AuthPrincipal.roleIds` /
 *    `dataScope` / `isOwner` 一律来自库。
 *
 * ## 装配
 *
 * ```ts
 * CoreModule.forRoot({ ... }),        // 必须在前：ConfigService + ContextMiddleware
 * PrismaModule.forRoot({ ... }),
 * AuthModule.forRoot({ redis: new Redis(env.REDIS_URL) }),
 * ```
 *
 * 登录 / 换店 / 登出的 **HTTP 控制器不在本包**——URL、DTO、Swagger、限流档位都是应用的
 * 决定，`apps/api`（T0-8）里那层薄控制器调 {@link AuthFlowService} 即可。
 *
 * @packageDocumentation
 */

// ── 装配 ────────────────────────────────────────────────────────────────
export { AuthModule, type AuthModuleOptions, type ResolvedOptions } from './auth.module'
export {
  AUTH_CLOCK,
  AUTH_CONCURRENCY,
  AUTH_OPTIONS,
  AUTH_REDIS,
  AUTH_TTL,
  MEMBERSHIP_PROVIDER,
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_STORE,
  TENANT_RESOLVERS,
} from './tokens'
export { systemClock, type Clock } from './clock'
export { InMemoryAuthRedis, takeOnce, type AuthRedis } from './redis'

// ── token ───────────────────────────────────────────────────────────────
export {
  AUTH_ERRORS,
  isTokenKind,
  TOKEN_KINDS,
  TOKEN_PAYLOAD_VERSION,
  type RefreshPayload,
  type SignablePayload,
  type TokenKind,
  type TokenPayload,
} from './token/jwt-payload'
export { refreshKey, TokenService, type TokenPair } from './token/token.service'
export { DEFAULT_TTL, resolveTtl, type TokenTtlConfig, type TokenTtlOverrides } from './token/ttl'

// ── 会话 ────────────────────────────────────────────────────────────────
export {
  DEFAULT_CONCURRENCY,
  SessionService,
  sessionKey,
  sessionSetKey,
  type ConcurrencyLimits,
  type SessionEntry,
} from './session/session.service'

// ── 成员关系 ────────────────────────────────────────────────────────────
export {
  CachedMembershipProvider,
  MEMBERSHIP_CACHE_MAX,
  MEMBERSHIP_TTL_MS,
  PrismaMembershipProvider,
  type Membership,
  type MembershipProvider,
} from './membership/membership.provider'

// ── 守卫与主体 ──────────────────────────────────────────────────────────
export { extractBearer, GlobalAuthGuard } from './guards/global-auth.guard'
export {
  foldMultilineDecorators,
  scanControllerSources,
  SENTINEL_EXPECTATION,
  SENTINEL_SOURCE,
  type DefaultDenyReport,
  type DefaultDenyViolation,
  type ScannedRoute,
  type SourceFile,
} from './guards/default-deny.scan'
export type { AuthPrincipal, DataScope, RequestWithPrincipal, StaffStatus } from './principal'

// ── 装饰器 ──────────────────────────────────────────────────────────────
export {
  Auth,
  AUTH_KINDS_KEY,
  CurrentUser,
  IS_PUBLIC_KEY,
  Public,
  RATE_LIMIT_KEY,
  RateLimited,
} from './decorators'

// ── 租户解析 ────────────────────────────────────────────────────────────
export {
  headerValue,
  isTenantFreePath,
  isTokenOnlyTenantPath,
  requestPath,
  TENANT_FREE_PREFIXES,
  TENANT_TOKEN_ONLY_PREFIXES,
  type ResolvableRequest,
  type TenantResolverStrategy,
} from './tenant-resolver/strategy'
export {
  SLUG_HEADER_PREFIX,
  SlugHeaderResolver,
  SubdomainResolver,
  TENANT_SLUG_HEADER,
  TokenTenantResolver,
  UNRESOLVABLE_TENANT_STATUSES,
} from './tenant-resolver/resolvers'
export {
  TenantMiddleware,
  TenantResolverChain,
  type TenantResolution,
} from './tenant-resolver/tenant.middleware'

// ── 验证码 ──────────────────────────────────────────────────────────────
export {
  CAPTCHA_TTL_SEC,
  captchaKey,
  CaptchaService,
  type Captcha,
  type CaptchaOptions,
} from './captcha/captcha.service'

// ── 流程 ────────────────────────────────────────────────────────────────
export { AuthFlowService, type IssuedTokens, type StaffLoginResult } from './auth-flow.service'

// ── 限流（T2-6）────────────────────────────────────────────────────────
//
// 判定与档位表在 `@taizan/ratelimit-core`（零框架依赖、107 个单测）；
// 这里只有接线：守卫、服务门面、Redis store、`resolveIps` 的 IP_RESOLVER 适配器。
export { ResolveIpsAdapter } from './ratelimit/ip-resolver'
export { provideRateLimitGuard } from './ratelimit/provide'
export {
  RateLimitedException,
  RETRY_AFTER_HEADER,
  setRetryAfter,
  type HeaderSettableResponse,
} from './ratelimit/rate-limit.exception'
export { RateLimitGuard } from './ratelimit/rate-limit.guard'
export {
  DEGRADE_LOG_INTERVAL_MS,
  FALLBACK_TIER,
  NO_CONTEXT_KEY,
  RateLimitService,
  type ConsumeOptions,
  type RateLimitRuntimeOptions,
} from './ratelimit/rate-limit.service'
export { RetryAfterInterceptor } from './ratelimit/retry-after.interceptor'
export { AuthRedisRateLimitStore } from './ratelimit/store'
