/**
 * `QueueService`：入队入口（蓝图 §4.7）。
 *
 * 唯一一件必须记住的事：**入队时封进信封的 `traceId` 是「发起方」的**，
 * 不是 worker 执行时的。worker 会拿它当 `parentTraceId`，从而把
 * 「用户点了这个按钮」和「十秒后后台发了这条短信」串成一条链路。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ulid } from '@taizan/contracts'
import { currentContext } from '@taizan/nest-core'
import type { JobEnvelope } from './envelope'
import { JOB_DEFAULTS, type JobBackoff } from './job-handler.decorator'
import { JobRegistry } from './job.registry'
import { QUEUE_DRIVER } from '../tokens'
import type { DriverAddOptions, QueueDriver } from './queue-driver'

/** {@link QueueService.add} 的可选项。 */
export interface AddJobOptions {
  /**
   * 任务归属租户。**不传时不会自动从上下文取**——
   * 「忘了传」和「这就是个平台级任务」必须区分得开，静默继承上下文会让平台任务
   * 莫名其妙带上最后一个访问者的租户。
   */
  tenantId?: string
  /** 延迟多久投递（毫秒）。 */
  delayMs?: number
  /**
   * 自定义 job id。**同 id 重复入队是幂等的**（BullMQ 与内存驱动都一样），
   * 所以「同一个订单只关一次」这种去重可以直接用它，不用另开幂等键。
   */
  jobId?: string
  /** 覆盖处理器上声明的最大尝试次数。 */
  attempts?: number
  /** 覆盖处理器上声明的退避策略。 */
  backoff?: JobBackoff
}

@Injectable()
export class QueueService {
  constructor(
    @Inject(QUEUE_DRIVER) private readonly driver: QueueDriver,
    @Inject(JobRegistry) private readonly registry: JobRegistry,
  ) {}

  /** 当前驱动名（`bullmq` / `memory`）。 */
  get driverKind(): string {
    return this.driver.kind
  }

  /**
   * 入队。
   *
   * @param name - 任务名，必须与某个 `@JobHandler({ name })` 对得上
   * @returns 队列内的 job id
   */
  async add<T>(name: string, data: T, opts: AddJobOptions = {}): Promise<string> {
    const ctx = currentContext()
    const envelope: JobEnvelope<T> = {
      originTenantId: opts.tenantId,
      // 没有上下文（比如启动脚本里直接入队）时也要有 traceId，否则 worker 端
      // parentTraceId 是 undefined，链路断在这里。
      traceId: ctx?.traceId ?? ulid(),
      parentTraceId: ctx?.parentTraceId,
      data,
      enqueuedAt: Date.now(),
    }
    return this.driver.add(name, envelope as JobEnvelope, this.driverOptions(name, opts))
  }

  /**
   * 原样重投一个已有信封（死信重放用）。
   *
   * 与 {@link QueueService.add} 的区别：不重新造信封，而是保留原始的
   * `originTenantId` 与业务 payload，只把 `traceId` 换成当前上下文的，
   * 并把原来的那个记进 `parentTraceId`——这样重放和原始那次在链路上是父子关系。
   */
  async replayEnvelope(
    name: string,
    envelope: JobEnvelope,
    opts: AddJobOptions = {},
  ): Promise<string> {
    const ctx = currentContext()
    const next: JobEnvelope = {
      ...envelope,
      traceId: ctx?.traceId ?? ulid(),
      parentTraceId: envelope.traceId,
      enqueuedAt: Date.now(),
    }
    return this.driver.add(name, next, this.driverOptions(name, opts))
  }

  /**
   * 组装驱动层选项。
   *
   * 优先级：调用点显式传的 > 处理器 `@JobHandler` 上声明的 > 全局默认值。
   * 中间那一档是关键——`attempts` / `backoff` 在 BullMQ 里是**入队时**的 job 选项，
   * 不查注册表的话，处理器上写的 `attempts: 5` 对由别的进程入队的消息完全无效。
   */
  private driverOptions(name: string, opts: AddJobOptions): DriverAddOptions {
    const declared = this.registry.defaultsFor(name)
    return {
      ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
      ...(opts.jobId !== undefined ? { jobId: opts.jobId } : {}),
      attempts: opts.attempts ?? declared?.attempts ?? JOB_DEFAULTS.attempts,
      backoff: opts.backoff ?? declared?.backoff ?? JOB_DEFAULTS.backoff,
    }
  }
}
