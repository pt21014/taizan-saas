/**
 * `@taizan/ratelimit-core`：三维度限流的**决策层**（蓝图 §2、§9 第 6 条不变量）。
 *
 * ## 这个包只做三件事
 *
 * 1. {@link resolveIps}：从 `X-Forwarded-For` **末尾**倒数 `TRUSTED_PROXY_HOPS` 段，
 *    解析出可信的客户端 IP 与入口 IP。全仓取客户端 IP 的**唯一**入口。
 * 2. {@link RATE_LIMIT_TIERS} + {@link assertTierSane}：档位表，
 *    以及「入口/账号维度必须比客户端维度宽松」这条硬约束的机器守卫。
 * 3. {@link decide}：三维度计数与判定，Redis 不可用时**退回进程内计数而不是放行**。
 *
 * ## 它刻意不做的事
 *
 * - 不认识 HTTP、express、Nest：入参是 `{ xff, socketIp, trustedHops }` 和
 *   `{ client, edge, account }` 这样的裸值，所以能在纯 node 里跑单测；
 * - 不认识 Redis：计数后端是注入的 {@link RateLimitStore}；
 * - 不抛 HTTP 异常、不设响应头：那是 `@taizan/nest-auth` 里 `RateLimitGuard` 的事。
 *
 * @packageDocumentation
 */

// ── IP 解析（不变量 6 的核心） ──────────────────────────────────────────
export {
  normalizeIp,
  resolveIps,
  UNKNOWN_IP,
  type ClientIpSource,
  type ResolvedIps,
  type ResolveIpsInput,
} from './resolve-ips'

// ── 档位表 ──────────────────────────────────────────────────────────────
export {
  ACCOUNT_LIMIT_FLOOR,
  assertAllTiersSane,
  assertTierSane,
  DEFAULT_TIER_MESSAGE,
  defineTier,
  EDGE_RATIO_FLOOR,
  findTier,
  isKnownTier,
  RATE_LIMIT_TIER_NAMES,
  RATE_LIMIT_TIERS,
  RateLimitConfigError,
  renderTierMessage,
  type RateLimitTier,
  type RateLimitTierName,
} from './config'

// ── 判定 ────────────────────────────────────────────────────────────────
export {
  ALL_DIMENSIONS,
  decide,
  resetProcessLocalCounters,
  sweepProcessLocalCounters,
  UnknownTierError,
  type DecideInput,
  type Decision,
  type RateLimitDimension,
  type RateLimitKeys,
} from './decide'

// ── 计数后端 ────────────────────────────────────────────────────────────
export {
  buildKey,
  MemoryRateLimitStore,
  RedisRateLimitStore,
  type RateLimitStore,
  type RedisLike,
} from './store'

// ── 静态扫描（spec 13） ─────────────────────────────────────────────────
export {
  DEFAULT_IP_SOURCE_ALLOWLIST,
  IP_SOURCE_SENTINEL_EXPECTATION,
  IP_SOURCE_SENTINEL_SOURCE,
  scanDirectIpReads,
  type IpSourceFile,
  type IpSourceReport,
  type IpSourceViolation,
  type ScanDirectIpReadsOptions,
} from './ip-source'
