/**
 * `@LeaderCron`：**集群安全**的定时任务装饰器（蓝图 §4.7、§8 第 12 条）。
 *
 * 与 `@nestjs/schedule` 的 `@Cron` 的区别只有一条，但这条决定了它能不能上生产：
 * 每个 tick 先抢一把分布式锁，抢不到就**跳过**（不是排队、不是等待）。
 * 4 个实例同一秒醒来，只有一个真正执行。
 *
 * `cluster-safe.spec.ts` 扫源码禁止裸 `@Cron`，就是为了让「忘了用 LeaderCron」
 * 在 CI 里红，而不是在生产里表现为「同一条到期短信发了 4 遍」。
 *
 * @packageDocumentation
 */

// `Reflect.defineMetadata` 来自 reflect-metadata（Nest 的 peer）。本文件不 import
// @nestjs/common，所以自己把 polyfill 引进来——它是幂等的，重复 import 无副作用。
import 'reflect-metadata'

/** 挂在方法上的 metadata key。 */
export const LEADER_CRON_METADATA = Symbol.for('@taizan/nest-infra:LEADER_CRON')

/** {@link LeaderCron} 的参数。 */
export interface LeaderCronOptions {
  /**
   * 任务标识。**同时是锁 key 与 `CronRun.key`**，全应用唯一（重名启动即抛）。
   * 用短横线小写，例如 `plan-expire-notify`。
   */
  key: string
  /** cron 表达式。支持 5 段（分 时 日 月 周）与 6 段（秒 分 时 日 月 周）。 */
  cron: string
  /**
   * leader 锁 TTL。**必须大于任务的正常耗时**，否则任务还在跑锁就过期了，
   * 下一个 tick 另一台实例会同时开跑。拿不准就开 `watchdog`。
   */
  lockTtlMs: number
  /** 开启续期看门狗（长任务必开）。见 `lock/watchdog.ts`。 */
  watchdog?: boolean
  /** IANA 时区，例如 `Asia/Shanghai`。不传用进程本地时区。 */
  timezone?: string
}

/** 注册表里一条 cron 定义（`CronRegistry` 扫描后产出）。 */
export interface LeaderCronDefinition extends LeaderCronOptions {
  /** 承载方法的 provider 实例。 */
  instance: object
  /** 方法名。 */
  methodName: string
}

/**
 * 声明一个 leader 定时任务。
 *
 * @example
 * ```ts
 * @Injectable()
 * export class PlanExpireNotifyCron {
 *   @LeaderCron({ key: 'plan-expire-notify', cron: '0 9 * * *', lockTtlMs: 300_000, watchdog: true })
 *   async run(): Promise<void> { ... }
 * }
 * ```
 */
export function LeaderCron(options: LeaderCronOptions): MethodDecorator {
  assertValidOptions(options)
  return <T>(
    _target: object,
    _propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ) => {
    const method: unknown = descriptor.value
    if (typeof method !== 'function') {
      throw new Error('[@taizan/nest-infra] @LeaderCron 只能加在方法上')
    }
    Reflect.defineMetadata(LEADER_CRON_METADATA, options, method as object)
    return descriptor
  }
}

/** 读取方法上的 `@LeaderCron` metadata。 */
export function getLeaderCronMetadata(method: unknown): LeaderCronOptions | undefined {
  if (typeof method !== 'function') return undefined
  return Reflect.getMetadata(LEADER_CRON_METADATA, method as object) as
    LeaderCronOptions | undefined
}

function assertValidOptions(options: LeaderCronOptions): void {
  if (!options.key || options.key.trim().length === 0) {
    throw new Error('[@taizan/nest-infra] @LeaderCron 必须有 key（它同时是锁 key 与 CronRun.key）')
  }
  if (!options.cron || options.cron.trim().length === 0) {
    throw new Error(`[@taizan/nest-infra] @LeaderCron("${options.key}") 缺少 cron 表达式`)
  }
  if (!Number.isFinite(options.lockTtlMs) || options.lockTtlMs <= 0) {
    throw new Error(
      `[@taizan/nest-infra] @LeaderCron("${options.key}") 的 lockTtlMs 必须是正数，收到 ${options.lockTtlMs}`,
    )
  }
}
