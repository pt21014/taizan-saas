/**
 * 队列驱动接口：把「消息怎么传」与「job 的语义」分开。
 *
 * ## 为什么要这层抽象
 *
 * 1. **BullMQ 跑不了 `ioredis-mock`**。它的 Lua 脚本用了 `cmsgpack`，mock 里的 Lua VM
 *    没有这个全局对象，`addStandardJob` 直接抛。而「job 失败进死信」「worker 里
 *    traceId/parentTraceId 对不对」这些是**语义**问题，不该被迫依赖一个真 Redis 才能测。
 *    所以语义层（`ProcessorFactory` / `DeadLetterService` / 信封）在内存驱动上测，
 *    真 BullMQ 另有一条 docker 起真 Redis 的集成 spec（见 README）。
 * 2. 本地开发不装 Redis 时也能把接口跑通（但会打一条 error 级日志，见 `memory.driver.ts`）。
 *
 * 驱动**只负责传输与重试调度**；上下文注入、死信落库、租户归属都在语义层，
 * 两个驱动共用同一份代码。
 *
 * @packageDocumentation
 */

import type { JobEnvelope } from './envelope'
import type { JobBackoff } from './job-handler.decorator'

/** 驱动交给上层的一次投递。 */
export interface DriverJob {
  /** 队列内的 job id。 */
  id: string
  /** 任务名（= 队列名）。 */
  name: string
  /** 信封（已反序列化）。 */
  envelope: JobEnvelope
  /** 这是第几次尝试（从 1 开始）。 */
  attempt: number
  /** 该 job 配置的最大尝试次数。 */
  maxAttempts: number
}

/** 入队选项。 */
export interface DriverAddOptions {
  delayMs?: number
  jobId?: string
  attempts?: number
  backoff?: JobBackoff
}

/** worker 选项。 */
export interface DriverWorkerOptions {
  concurrency: number
}

/** worker 回调：抛异常 = 本次尝试失败。 */
export type DriverHandler = (job: DriverJob) => Promise<void>

/** 尝试次数耗尽后的回调（只调一次）。 */
export type DriverFailedHandler = (job: DriverJob, error: unknown) => Promise<void>

/** 一个已启动的 worker。 */
export interface DriverWorker {
  close(): Promise<void>
}

/** 队列驱动。 */
export interface QueueDriver {
  /** 驱动名，进日志用（`bullmq` / `memory`）。 */
  readonly kind: string
  /** 入队，返回 job id。 */
  add(name: string, envelope: JobEnvelope, opts: DriverAddOptions): Promise<string>
  /** 起一个 worker。 */
  startWorker(
    name: string,
    opts: DriverWorkerOptions,
    handler: DriverHandler,
    onExhausted: DriverFailedHandler,
  ): Promise<DriverWorker>
  /** 关掉所有连接。 */
  close(): Promise<void>
}

/** 算第 `attempt` 次失败后应该等多久再重试。 */
export function backoffDelayMs(backoff: JobBackoff, attempt: number): number {
  if (backoff.type === 'fixed') return backoff.delayMs
  return backoff.delayMs * Math.pow(2, Math.max(0, attempt - 1))
}
