/**
 * 本包的全部注入 token。
 *
 * 一律用 `Symbol.for(...)`：字符串 token 会在「同一个包被装两份」时静默变成两个不同的
 * provider，而 `Symbol.for` 走全局符号注册表，跨副本仍是同一个键。
 *
 * @packageDocumentation
 */

/** ioredis 实例（或任何满足 `RedisClient` 结构的客户端）。 */
export const INFRA_REDIS = Symbol.for('@taizan/nest-infra:INFRA_REDIS')

/** `InfraModuleOptions`（已填好默认值的规范化版本）。 */
export const INFRA_OPTIONS = Symbol.for('@taizan/nest-infra:INFRA_OPTIONS')

/**
 * 本进程的实例标识：`hostname#pid#ulid`。
 *
 * 为什么还要带 ulid：容器里 hostname 会重名（同一个 Deployment 重建后 pid 也常常是 1），
 * 只靠 `hostname+pid` 的话，`CronRun.instanceId` 分不出「同一台机器重启前后」的两次执行。
 */
export const INFRA_INSTANCE_ID = Symbol.for('@taizan/nest-infra:INFRA_INSTANCE_ID')

/** 队列驱动（BullMQ 或内存）。 */
export const QUEUE_DRIVER = Symbol.for('@taizan/nest-infra:QUEUE_DRIVER')

/** 日志器。默认是 Nest 自带的 `Logger`，业务侧可以传 `AppLogger` 进来。 */
export const INFRA_LOGGER = Symbol.for('@taizan/nest-infra:INFRA_LOGGER')

/** Redis key 前缀（含结尾分隔符），默认 `taizan:`。 */
export const INFRA_KEY_PREFIX = Symbol.for('@taizan/nest-infra:INFRA_KEY_PREFIX')
