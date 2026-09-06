/**
 * `@taizan/nest-infra`：集群安全的基础设施层（蓝图 §4.7）。
 *
 * ## 这个包存在的理由
 *
 * 老项目 knowledge 线上有一条活故障：pm2 cluster 起 4 个进程，
 * `order-close.service.ts` / `profit-sharing.service.ts` 里的裸 `setInterval`
 * 于是每 30 秒同时跑 4 遍——同一笔订单被关 4 次、同一笔分账被发起 4 次。
 * 这不是「浪费点 CPU」，是重复的对外副作用。
 *
 * 本包用四件东西根治它：
 *
 * | 机制 | 入口 | 守的问题 |
 * |---|---|---|
 * | 分布式锁 | {@link LockService.withLock} | 同一段临界区多实例同时进 |
 * | leader cron | {@link LeaderCron} | 同一个定时任务多实例同时跑 |
 * | 幂等 | {@link IdempotencyService.run} | 同一个请求/回调被处理两次 |
 * | 队列 + 死信 | {@link QueueService} / {@link DeadLetterService} | 失败任务无声消失 |
 *
 * 外加两个横切约定：租户前缀缓存（{@link CacheService}，缺租户上下文直接抛）与
 * 后台执行的 traceId 注入（{@link runInFreshContext}，新 traceId + parentTraceId）。
 *
 * 而 {@link scanClusterSafety} 是把这些约定变成 CI 断言的静态扫描器
 * （蓝图 §8 第 12 条），T0-8 的全仓 spec 与 T4-2 的生成器模板直接复用它。
 *
 * @packageDocumentation
 */

// ── 装配 ────────────────────────────────────────────────────────────────
export { InfraModule } from './infra.module'
export {
  INFRA_ENV_SHAPE,
  makeInstanceId,
  normalizeInfraOptions,
  readEnvBoolean,
  type InfraModuleOptions,
  type InfraQueueOptions,
  type NormalizedInfraOptions,
} from './infra.options'
export {
  INFRA_INSTANCE_ID,
  INFRA_KEY_PREFIX,
  INFRA_LOGGER,
  INFRA_OPTIONS,
  INFRA_REDIS,
  QUEUE_DRIVER,
} from './tokens'
export type { InfraLogger } from './logging'

// ── 上下文 ──────────────────────────────────────────────────────────────
export { BACKGROUND_IP, runInFreshContext, type FreshContextInit } from './context'

// ── Redis ───────────────────────────────────────────────────────────────
export {
  DEFAULT_KEY_PREFIX,
  PING_TIMEOUT_MS,
  RedisHealthIndicator,
  RedisService,
} from './redis/redis.service'
export type { RedisClient, ScanPage } from './redis/redis-client'

// ── 锁 ──────────────────────────────────────────────────────────────────
export {
  LockService,
  LOCK_KEY_PREFIX,
  normalizeLockKey,
  type AcquiredLock,
  type WithLockOptions,
} from './lock/lock.service'
export { startWatchdog, type RenewFn, type WatchdogHandle } from './lock/watchdog'
export { RELEASE_LOCK_LUA, RENEW_LOCK_LUA } from './lock/scripts'

// ── cron ────────────────────────────────────────────────────────────────
export {
  getLeaderCronMetadata,
  LeaderCron,
  LEADER_CRON_METADATA,
  type LeaderCronDefinition,
  type LeaderCronOptions,
} from './cron/leader-cron.decorator'
export { CronRegistry } from './cron/cron.registry'
export { CronRunRecorder } from './cron/cron-run.recorder'
export { CronScheduler, CRON_LOCK_NAMESPACE, type CronTickOutcome } from './cron/cron.scheduler'

// ── 队列 ────────────────────────────────────────────────────────────────
export { isJobEnvelope, type JobEnvelope } from './queue/envelope'
export {
  getJobHandlerMetadata,
  JobHandler,
  JOB_DEFAULTS,
  JOB_HANDLER_METADATA,
  normalizeJobOptions,
  type JobBackoff,
  type JobHandlerDefinition,
  type JobHandlerOptions,
  type JobProcessor,
} from './queue/job-handler.decorator'
export { JobRegistry } from './queue/job.registry'
export { QueueService, type AddJobOptions } from './queue/queue.service'
export { ProcessorFactory } from './queue/processor.factory'
export {
  DeadLetterService,
  type DeadLetterEntry,
  type DeadLetterRow,
} from './queue/dead-letter.service'
export {
  backoffDelayMs,
  type DriverAddOptions,
  type DriverFailedHandler,
  type DriverHandler,
  type DriverJob,
  type DriverWorker,
  type DriverWorkerOptions,
  type QueueDriver,
} from './queue/queue-driver'
export { BullMqQueueDriver, type BullMqDriverOptions } from './queue/bullmq.driver'
export { MemoryQueueDriver } from './queue/memory.driver'

// ── 幂等 ────────────────────────────────────────────────────────────────
export {
  DEFAULT_IDEMPOTENCY_TTL_SEC,
  IdempotencyService,
  IDEMPOTENCY_PENDING,
  idempotencyRedisKey,
  type IdempotencyOutcome,
} from './idempotency/idempotency.service'

// ── 缓存 ────────────────────────────────────────────────────────────────
export { CacheService } from './cache/cache.service'
export {
  buildCacheKey,
  buildNamespacePattern,
  CacheTenantContextError,
  isPlatformNamespace,
  PLATFORM_NS_PREFIX,
  PLATFORM_TENANT_SLOT,
} from './cache/key-builder'

// ── 发件箱 ──────────────────────────────────────────────────────────────
export {
  OutboxService,
  OUTBOX_EVENT,
  type OutboxEventInput,
  type OutboxRow,
} from './outbox/outbox.service'
export { OutboxRelay, OUTBOX_BATCH_SIZE, OUTBOX_MAX_ATTEMPTS } from './outbox/outbox.relay'

// ── 静态约束扫描（供 T0-8 / T4-2 复用） ─────────────────────────────────
export {
  ALLOW_MARKER,
  DEFAULT_TIMER_ALLOWLIST,
  formatViolations,
  PROCESS_LOCAL_MARKER,
  scanClusterSafety,
  type ClusterSafetyOptions,
  type ClusterSafetyViolation,
  type SourceFile,
} from './cluster-safe/scan'
