/**
 * `@JobHandler` + `JobProcessor<T>`：队列处理器的声明方式（蓝图 §4.7）。
 *
 * 一个 job name 对应一个 BullMQ 队列，也对应一个处理器类。`ProcessorFactory` 用
 * `DiscoveryService` 把它们扫出来自动建 worker——业务侧只写类，不写装配。
 *
 * @packageDocumentation
 */

// `Reflect.defineMetadata` 来自 reflect-metadata（Nest 的 peer）。本文件不 import
// @nestjs/common，所以自己把 polyfill 引进来——它是幂等的，重复 import 无副作用。
import 'reflect-metadata'
import type { JobEnvelope } from './envelope'

/** 挂在类上的 metadata key。 */
export const JOB_HANDLER_METADATA = Symbol.for('@taizan/nest-infra:JOB_HANDLER')

/** 重试退避策略。 */
export interface JobBackoff {
  type: 'fixed' | 'exponential'
  /** 基准间隔（毫秒）。`exponential` 时第 n 次重试等 `delayMs * 2^(n-1)`。 */
  delayMs: number
}

/** {@link JobHandler} 的参数。 */
export interface JobHandlerOptions {
  /** 任务名。**同时是队列名**，全应用唯一。用点分小写，例如 `goods.sync`。 */
  name: string
  /** 单实例并发度，默认 1。注意这是**每个实例**的并发，4 个实例就是 4 倍。 */
  concurrency?: number
  /** 最大尝试次数（含首次），默认 3。 */
  attempts?: number
  /** 退避策略，默认 `{ type: 'exponential', delayMs: 2000 }`。 */
  backoff?: JobBackoff
  /**
   * 尝试次数耗尽后是否落 `JobDeadLetter`，默认 `true`。
   *
   * 关掉它意味着「失败就彻底消失」。只有那种「丢了也无所谓、下一轮还会重算」的任务
   * （比如缓存预热）才应该关。
   */
  deadLetter?: boolean
}

/** 处理器要实现的接口。 */
export interface JobProcessor<T = unknown> {
  /**
   * 处理一条消息。
   *
   * 调用时已经在正确的上下文里：新 traceId、`parentTraceId` 指向入队方、
   * `tenantId` 来自信封——所以里面照常可以用 `prisma.tenant`。
   *
   * **抛异常 = 这次尝试失败**，队列会按 `backoff` 重试；不抛就算成功。
   */
  process(envelope: JobEnvelope<T>): Promise<void>
}

/** 注册表里一条处理器定义。 */
export interface JobHandlerDefinition extends Required<Omit<JobHandlerOptions, 'backoff'>> {
  backoff: JobBackoff
  instance: JobProcessor
}

/** 默认值集中在这里，`ProcessorFactory` 与 `QueueService` 共用。 */
export const JOB_DEFAULTS = {
  concurrency: 1,
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 2000 } as JobBackoff,
  deadLetter: true,
} as const

/**
 * 声明一个队列处理器。
 *
 * @example
 * ```ts
 * @JobHandler({ name: 'goods.sync', concurrency: 5, attempts: 5 })
 * export class GoodsSyncHandler implements JobProcessor<GoodsSyncPayload> {
 *   async process(env: JobEnvelope<GoodsSyncPayload>): Promise<void> { ... }
 * }
 * ```
 */
export function JobHandler(options: JobHandlerOptions): ClassDecorator {
  if (!options.name || options.name.trim().length === 0) {
    throw new Error('[@taizan/nest-infra] @JobHandler 必须有 name（它同时是队列名）')
  }
  return (target) => {
    Reflect.defineMetadata(JOB_HANDLER_METADATA, options, target)
    return target
  }
}

/** 读取类上的 `@JobHandler` metadata。 */
export function getJobHandlerMetadata(target: unknown): JobHandlerOptions | undefined {
  if (typeof target !== 'function') return undefined
  return Reflect.getMetadata(JOB_HANDLER_METADATA, target) as JobHandlerOptions | undefined
}

/** 补齐默认值。 */
export function normalizeJobOptions(
  options: JobHandlerOptions,
): Omit<JobHandlerDefinition, 'instance'> {
  return {
    name: options.name,
    concurrency: options.concurrency ?? JOB_DEFAULTS.concurrency,
    attempts: options.attempts ?? JOB_DEFAULTS.attempts,
    backoff: options.backoff ?? JOB_DEFAULTS.backoff,
    deadLetter: options.deadLetter ?? JOB_DEFAULTS.deadLetter,
  }
}
