/**
 * `ProcessorFactory`：扫出所有 `@JobHandler`，为每个 name 建一个 worker。
 *
 * 这里是队列侧最容易漏的那件事的落点（蓝图 §4.11）：
 *
 * ```
 * runWithContext({
 *   traceId:       新 ulid,              ← 这次执行自己的
 *   parentTraceId: envelope.traceId,     ← 入队方的，链路靠它串回去
 *   tenantId:      envelope.originTenantId,
 * })
 * ```
 *
 * 漏了 `tenantId` 的后果比链路断更严重：处理器里用 `prisma.tenant` 会直接抛
 * 「无租户上下文」——这算好的；万一处理器改用了 `prisma.raw`，那就是跨租户写数据。
 *
 * `QUEUE_ENABLED=false` 时**只建 Queue 不建 Worker**：入队照常，消费交给专门的
 * worker 进程。web 进程和 worker 进程分开部署时，这个开关是唯一的分界。
 *
 * @packageDocumentation
 */

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { runInFreshContext } from '../context'
import { INFRA_LOGGER, INFRA_OPTIONS, QUEUE_DRIVER } from '../tokens'
import type { InfraLogger } from '../logging'
import type { NormalizedInfraOptions } from '../infra.options'
import { DeadLetterService } from './dead-letter.service'
import type { JobHandlerDefinition } from './job-handler.decorator'
import { JobRegistry } from './job.registry'
import type { DriverJob, DriverWorker, QueueDriver } from './queue-driver'

@Injectable()
export class ProcessorFactory implements OnApplicationBootstrap, OnApplicationShutdown {
  // process-local: 本进程起的 worker 句柄，关停时逐个 close。
  private readonly workers = new Map<string, DriverWorker>()

  private definitions: JobHandlerDefinition[] = []

  constructor(
    @Inject(JobRegistry) private readonly registry: JobRegistry,
    @Inject(QUEUE_DRIVER) private readonly driver: QueueDriver,
    @Inject(DeadLetterService) private readonly deadLetter: DeadLetterService,
    @Inject(INFRA_OPTIONS) private readonly options: NormalizedInfraOptions,
    @Inject(INFRA_LOGGER) private readonly logger: InfraLogger,
  ) {}

  /** 已发现的处理器定义。 */
  get discovered(): readonly JobHandlerDefinition[] {
    return this.definitions
  }

  async onApplicationBootstrap(): Promise<void> {
    // 与 CronScheduler 同理：即使本进程不消费，name 重复这类错误也要在启动时炸出来。
    this.definitions = this.registry.discover()

    if (!this.options.queueEnabled) {
      this.logger.warn(
        `[@taizan/nest-infra] QUEUE_ENABLED=false，本进程只入队不消费（发现 ${this.definitions.length} 个 @JobHandler）`,
        'ProcessorFactory',
      )
      return
    }
    for (const def of this.definitions) {
      this.workers.set(def.name, await this.startWorker(def))
    }
    this.logger.log(
      `[@taizan/nest-infra] 已启动 ${this.workers.size} 个队列 worker（driver=${this.driver.kind}）`,
      'ProcessorFactory',
    )
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.close()))
    this.workers.clear()
  }

  /**
   * 执行一条消息。**测试直接调它**，不用起 worker。
   *
   * @returns 这次执行用的（新）traceId
   */
  async execute(def: JobHandlerDefinition, job: DriverJob): Promise<string> {
    const env = job.envelope
    return runInFreshContext(
      { parentTraceId: env.traceId, tenantId: env.originTenantId },
      async (traceId) => {
        await def.instance.process(env)
        return traceId
      },
    )
  }

  private async startWorker(def: JobHandlerDefinition): Promise<DriverWorker> {
    return this.driver.startWorker(
      def.name,
      { concurrency: def.concurrency },
      async (job) => {
        await this.execute(def, job)
      },
      async (job, error) => {
        if (!def.deadLetter) {
          this.logger.error(
            `[@taizan/nest-infra] job "${def.name}" 重试耗尽且未开启死信，消息丢弃：` +
              (error instanceof Error ? error.message : String(error)),
            undefined,
            'ProcessorFactory',
          )
          return
        }
        // 落死信也要在上下文里：这样 DeadLetterService 的日志同样有 traceId 可查。
        await runInFreshContext(
          { parentTraceId: job.envelope.traceId, tenantId: job.envelope.originTenantId },
          async (traceId) => {
            await this.deadLetter.record({
              queue: def.name,
              jobName: def.name,
              originTenantId: job.envelope.originTenantId,
              payload: job.envelope,
              attempts: job.attempt,
              lastError: error,
              traceId,
            })
          },
        )
      },
    )
  }
}
