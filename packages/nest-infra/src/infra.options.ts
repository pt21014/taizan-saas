/**
 * `InfraModule.forRoot()` 的选项与它们的默认值。
 *
 * 两个开关（`cronEnabled` / `queueEnabled`）刻意**不从 `ConfigService` 里读**：
 * `@taizan/nest-core` 的 `BASE_ENV_SCHEMA` 里没有这两个字段，而本包不能去改它
 * （那是另一个包的契约）。所以约定是：业务项目用 `defineEnvSchema` 把
 * {@link INFRA_ENV_SHAPE} 合进自己的 env schema，再在 `forRoot` 里显式传进来。
 * 不传时退化成直接读 `process.env`，这样最小装配也能跑。
 *
 * @packageDocumentation
 */

import { hostname } from 'node:os'
import { z } from 'zod'
import { ulid } from '@taizan/contracts'
import type { ConnectionOptions } from 'bullmq'
import type { RedisClient } from './redis/redis-client'
import type { QueueDriver } from './queue/queue-driver'
import type { InfraLogger } from './logging'
import { DEFAULT_KEY_PREFIX } from './redis/redis.service'

/**
 * 本包需要的 env 字段。业务项目这样合进去：
 *
 * ```ts
 * export const APP_ENV_SCHEMA = defineEnvSchema(BASE_ENV_SCHEMA, { ...INFRA_ENV_SHAPE })
 * ```
 */
export const INFRA_ENV_SHAPE = {
  CRON_ENABLED: envBoolean(true).describe(
    '本进程是否参与 @LeaderCron 调度。只跑 HTTP 的进程置 false，避免它抢到 leader 却缺依赖',
  ),
  QUEUE_ENABLED: envBoolean(true).describe(
    '本进程是否消费队列。false 时只入队不起 worker（web / worker 分开部署时用）',
  ),
} as const

/** 队列装配选项。 */
export interface InfraQueueOptions {
  /**
   * BullMQ 连接。**传连接选项对象，不要传现成的 ioredis 实例**——
   * worker 的阻塞命令会把共用连接上的其他命令堵住，理由见 `bullmq.driver.ts`。
   */
  connection?: ConnectionOptions
  /** BullMQ 自己的 key 前缀。 */
  prefix?: string
  /** 直接指定驱动（测试用，或者将来换别的队列实现）。给了就不看 `connection`。 */
  driver?: QueueDriver
}

/** {@link InfraModule.forRoot} 的选项。 */
export interface InfraModuleOptions {
  /**
   * Redis 客户端。锁 / 缓存 / 幂等 / 一次性凭据共用这一条连接。
   *
   * 生产传 `new Redis(env.REDIS_URL)`，单测传 `new RedisMock()`。
   */
  redis: RedisClient
  /** Redis key 前缀，默认 `taizan:`。同一台 Redis 上跑多个站时务必区分开。 */
  prefix?: string
  /** 本进程是否调度 cron。不传时读 `process.env.CRON_ENABLED`（默认开）。 */
  cronEnabled?: boolean
  /** 本进程是否消费队列。不传时读 `process.env.QUEUE_ENABLED`（默认开）。 */
  queueEnabled?: boolean
  /** 队列装配。 */
  queue?: InfraQueueOptions
  /** 是否注册发件箱（`OutboxService` + `OutboxRelay`），默认 `false`。 */
  outbox?: boolean
  /** 日志器。不传时用 Nest 自带的 `Logger`；生产传 `AppLogger`。 */
  logger?: InfraLogger
  /** 实例标识。不传时是 `hostname#pid#ulid`。 */
  instanceId?: string
}

/** 填好默认值之后的选项。 */
export interface NormalizedInfraOptions {
  prefix: string
  cronEnabled: boolean
  queueEnabled: boolean
  outbox: boolean
  instanceId: string
  queue: InfraQueueOptions
}

/** 生成本进程的实例标识。 */
export function makeInstanceId(): string {
  return `${hostname()}#${process.pid}#${ulid()}`
}

/** 填默认值。 */
export function normalizeInfraOptions(options: InfraModuleOptions): NormalizedInfraOptions {
  return {
    prefix: options.prefix ?? DEFAULT_KEY_PREFIX,
    cronEnabled: options.cronEnabled ?? readEnvBoolean('CRON_ENABLED', true),
    queueEnabled: options.queueEnabled ?? readEnvBoolean('QUEUE_ENABLED', true),
    outbox: options.outbox ?? false,
    instanceId: options.instanceId ?? makeInstanceId(),
    queue: options.queue ?? {},
  }
}

/**
 * 从 `process.env` 读布尔开关。
 *
 * 与 nest-core 的 `envBoolean` 同一套口径，但**拼错的值不静默当 false**：
 * `CRON_ENABLED=ture` 静默变成 false 的后果是「所有定时任务都不跑了，而且没人发现」。
 */
export function readEnvBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return defaultValue
  const s = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  throw new Error(
    `[@taizan/nest-infra] 环境变量 ${name} 的值 "${raw}" 不是合法布尔值（1/true/yes/on 或 0/false/no/off）`,
  )
}

function envBoolean(defaultValue: boolean) {
  return z
    .preprocess((raw) => {
      if (raw === undefined || raw === '') return defaultValue
      if (typeof raw === 'boolean') return raw
      const s = String(raw).trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(s)) return true
      if (['0', 'false', 'no', 'off'].includes(s)) return false
      return raw
    }, z.boolean())
    .default(defaultValue)
}
