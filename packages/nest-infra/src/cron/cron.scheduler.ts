/**
 * `CronScheduler`：`@LeaderCron` 的调度器。
 *
 * ## 每个 tick 干什么
 *
 * ```
 * 到点 → runInFreshContext（新 traceId，无 parentTraceId）
 *      → withLock('cron:<key>')  ── 抢不到 ──▶ debug 一行，跳过（不排队！）
 *              │ 抢到
 *              ▼ CronRun.start → 执行方法 → CronRun.finish(ok / error)
 * ```
 *
 * ## 三个刻意的选择
 *
 * - **抢不到锁就跳过，不排队**。排队等于把并发推迟到下一秒，而 cron 的语义本来就是
 *   「到点做一次」，不是「一定要做 N 次」。
 * - **用 `setTimeout` 逐次重排，不用 `setInterval`**。`setInterval` 的周期是固定的，
 *   而 cron 表达式的间隔不是（`0 9 * * *` 的下一次可能是 24 小时后，也可能因为夏令时
 *   是 23 或 25 小时后）。每次执行完重新算下一个时间点才是对的。这也是本包唯一允许出现
 *   调度定时器的地方（`cluster-safe.spec.ts` 的白名单）。
 * - **`CRON_ENABLED=false` 时完全不调度**。只跑 HTTP 的进程不该参与抢锁——它们抢到了，
 *   任务就落在一台没有对应依赖的机器上。
 *
 * @packageDocumentation
 */

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { CronExpressionParser } from 'cron-parser'
import { runInFreshContext } from '../context'
import { LockService } from '../lock/lock.service'
import { INFRA_INSTANCE_ID, INFRA_LOGGER, INFRA_OPTIONS } from '../tokens'
import type { InfraLogger } from '../logging'
import type { NormalizedInfraOptions } from '../infra.options'
import { CronRegistry } from './cron.registry'
import { CronRunRecorder } from './cron-run.recorder'
import type { LeaderCronDefinition } from './leader-cron.decorator'

/** cron 锁 key 的命名空间。最终 Redis key 形如 `taizan:lock:cron:<key>`。 */
export const CRON_LOCK_NAMESPACE = 'cron:'

/** 一次 tick 的结果，供测试与运维台断言。 */
export interface CronTickOutcome {
  key: string
  /** 是否抢到了 leader 锁。`false` 表示这台实例这一轮跳过了。 */
  leader: boolean
  ok: boolean
  traceId: string
  error?: unknown
}

@Injectable()
export class CronScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  // process-local: 只是本进程自己的定时器句柄，关停时逐个 clearTimeout 用；
  // 不承载任何跨进程状态——跨进程协调全部在 Redis 锁里。
  private readonly timers = new Map<string, NodeJS.Timeout>()

  private definitions: LeaderCronDefinition[] = []
  private stopped = false

  constructor(
    @Inject(CronRegistry) private readonly registry: CronRegistry,
    @Inject(LockService) private readonly lock: LockService,
    @Inject(CronRunRecorder) private readonly recorder: CronRunRecorder,
    @Inject(INFRA_INSTANCE_ID) private readonly instanceId: string,
    @Inject(INFRA_OPTIONS) private readonly options: NormalizedInfraOptions,
    @Inject(INFRA_LOGGER) private readonly logger: InfraLogger,
  ) {}

  /** 已发现的定义。 */
  get discovered(): readonly LeaderCronDefinition[] {
    return this.definitions
  }

  /** 本进程是否真的在调度。 */
  get scheduling(): boolean {
    return this.timers.size > 0
  }

  onApplicationBootstrap(): void {
    // 先扫描再判开关：即使本进程不调度，key 重名这类错误也该在启动时炸出来，
    // 否则「只有跑 cron 的那台机器启动失败」会让问题拖到部署当天才暴露。
    this.definitions = this.registry.discover()

    if (!this.options.cronEnabled) {
      this.logger.warn(
        `[@taizan/nest-infra] CRON_ENABLED=false，本进程不调度 ${this.definitions.length} 个 @LeaderCron 任务`,
        'CronScheduler',
      )
      return
    }
    for (const def of this.definitions) {
      this.schedule(def)
    }
    this.logger.log(
      `[@taizan/nest-infra] 已调度 ${this.definitions.length} 个 @LeaderCron 任务（instance=${this.instanceId}）`,
      'CronScheduler',
    )
  }

  onApplicationShutdown(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** 下一次执行的时间戳（毫秒）。 */
  nextFireAt(def: LeaderCronDefinition, from: Date = new Date()): number {
    const expression = CronExpressionParser.parse(def.cron, {
      currentDate: from,
      ...(def.timezone ? { tz: def.timezone } : {}),
    })
    return expression.next().getTime()
  }

  private schedule(def: LeaderCronDefinition): void {
    if (this.stopped) return
    let delay: number
    try {
      delay = Math.max(1, this.nextFireAt(def) - Date.now())
    } catch (err) {
      // 表达式非法不能静默不调度（那等于任务永远不跑），必须响亮地失败。
      throw new Error(
        `[@taizan/nest-infra] @LeaderCron("${def.key}") 的 cron 表达式 "${def.cron}" 解析失败：` +
          (err instanceof Error ? err.message : String(err)),
      )
    }

    // cluster-safe-allow: cron 调度器本体，逐次重排而非 setInterval（理由见文件头）
    const timer = setTimeout(() => {
      void this.runTick(def).finally(() => this.schedule(def))
    }, delay)
    timer.unref?.()
    this.timers.set(def.key, timer)
  }

  /**
   * 跑一个 tick。**测试直接调它**，不必等真实时间。
   *
   * 整个 tick（包括抢锁失败那条分支）都在新上下文里，所以「谁跳过了」在日志里
   * 也有 traceId 可查。
   */
  async runTick(def: LeaderCronDefinition): Promise<CronTickOutcome> {
    return runInFreshContext({}, async (traceId): Promise<CronTickOutcome> => {
      const outcome = await this.lock.withLock(
        `${CRON_LOCK_NAMESPACE}${def.key}`,
        def.lockTtlMs,
        async (): Promise<CronTickOutcome> => {
          const runId = await this.recorder.start(def.key, this.instanceId)
          try {
            await this.invoke(def)
            await this.recorder.finish(runId, true)
            return { key: def.key, leader: true, ok: true, traceId }
          } catch (err) {
            await this.recorder.finish(runId, false, err)
            // 不吞异常：打 error，同时把它带回 outcome 供测试与运维台断言。
            this.logger.error(
              `[@taizan/nest-infra] @LeaderCron("${def.key}") 执行失败：` +
                (err instanceof Error ? err.message : String(err)),
              err instanceof Error ? err.stack : undefined,
              'CronScheduler',
            )
            return { key: def.key, leader: true, ok: false, traceId, error: err }
          }
        },
        { watchdog: def.watchdog === true },
      )

      if (outcome === null) {
        this.logger.debug?.(
          `[@taizan/nest-infra] @LeaderCron("${def.key}") 未抢到 leader，本轮跳过`,
          'CronScheduler',
        )
        return { key: def.key, leader: false, ok: true, traceId }
      }
      return outcome
    })
  }

  private async invoke(def: LeaderCronDefinition): Promise<void> {
    const method = (def.instance as Record<string, unknown>)[def.methodName]
    if (typeof method !== 'function') {
      throw new TypeError(
        `[@taizan/nest-infra] @LeaderCron("${def.key}") 指向的方法 ${def.methodName} 不存在`,
      )
    }
    await (method as (this: object) => unknown).call(def.instance)
  }
}
