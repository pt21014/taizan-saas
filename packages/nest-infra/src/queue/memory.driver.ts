/**
 * `MemoryQueueDriver`：进程内队列驱动。
 *
 * **不是生产用的**。它存在的理由有两个：
 *
 * 1. 单测里驱动语义层（上下文注入、重试、死信、重放）——BullMQ 跑不了 `ioredis-mock`，
 *    见 `queue-driver.ts` 的文件头。
 * 2. 本地开发没装 Redis 时也能把链路跑通。
 *
 * 用它的时候 `InfraModule` 会打一条 **error 级**日志。不是 warn：多实例部署下每个进程
 * 各有一份队列，「消息发给了另一台实例」这种故障看起来就像消息凭空消失，
 * 值得在日志里刺眼一点。
 *
 * @packageDocumentation
 */

import type { JobEnvelope } from './envelope'
import {
  backoffDelayMs,
  type DriverAddOptions,
  type DriverFailedHandler,
  type DriverHandler,
  type DriverJob,
  type DriverWorker,
  type DriverWorkerOptions,
  type QueueDriver,
} from './queue-driver'
import { JOB_DEFAULTS, type JobBackoff } from './job-handler.decorator'

interface Pending {
  id: string
  name: string
  envelope: JobEnvelope
  attempt: number
  maxAttempts: number
  backoff: JobBackoff
  readyAt: number
}

interface Registration {
  opts: DriverWorkerOptions
  handler: DriverHandler
  onExhausted: DriverFailedHandler
  closed: boolean
}

export class MemoryQueueDriver implements QueueDriver {
  readonly kind = 'memory'

  // process-local: 内存驱动的本质就是「队列只活在本进程里」，这两张表正是它的存储。
  // 生产环境请用 BullMQ 驱动（InfraModule 在用到内存驱动时会打 error 日志）。
  private readonly pending = new Map<string, Pending>()
  // process-local: 同上——每个 name 一个 worker 注册项。
  private readonly workers = new Map<string, Registration>()
  // process-local: 已经见过的显式 jobId。BullMQ 里去重靠 Redis 上留存的 job 记录，
  // 内存驱动没有那份记录，就用这个集合复刻同样的语义（同 id 重复入队是幂等的）。
  private readonly knownIds = new Set<string>()

  private seq = 0
  private closed = false

  /**
   * 消费串行化的唯一机关。
   *
   * 之前的实现是「`add()`/`startWorker()` 触发的 `kick()`」与「测试调用的
   * `drain()`」各跑各的 `runOnce()` 循环：两个循环谁都不知道对方的存在，
   * 于是会同时从 `pending`/`workers` 里取任务——`drain()` 用来判断「跑完了」
   * 的 `hasFuture()` 检查完全没考虑另一个循环里正在处理、还没来得及重新入队
   * （重试）或者还没执行完 handler 的任务，导致 `await drain()` 提前返回，
   * 队列其实还没静止（并发 `add` 时偶发漏处理），也可能出现两个循环同一时刻
   * 各挑了一个任务、handler 真正**并发**跑起来而不是本驱动一贯的串行语义。
   *
   * 现在只留一条 promise 链：无论是 `add()`、`startWorker()` 还是 `drain()`，
   * 都只能把「再跑一轮 `runOnce()` 直到队列空」这件事追加到链尾，链本身保证
   * 同一时刻最多有一个 `pumpLoop()` 在真正消费 `pending`/`workers`。
   */
  private pumpChain: Promise<void> = Promise.resolve()

  async add(name: string, envelope: JobEnvelope, opts: DriverAddOptions): Promise<string> {
    this.seq += 1
    const id = opts.jobId ?? `mem-${this.seq}`
    if (opts.jobId !== undefined) {
      // 与 BullMQ 的 jobId 去重语义对齐：同 id 重复入队是幂等的，不报错。
      if (this.knownIds.has(id)) return id
      this.knownIds.add(id)
    }
    this.pending.set(id, {
      id,
      name,
      envelope,
      attempt: 0,
      maxAttempts: opts.attempts ?? JOB_DEFAULTS.attempts,
      backoff: opts.backoff ?? JOB_DEFAULTS.backoff,
      readyAt: Date.now() + (opts.delayMs ?? 0),
    })
    this.kick()
    return id
  }

  async startWorker(
    name: string,
    opts: DriverWorkerOptions,
    handler: DriverHandler,
    onExhausted: DriverFailedHandler,
  ): Promise<DriverWorker> {
    const registration: Registration = { opts, handler, onExhausted, closed: false }
    this.workers.set(name, registration)
    this.kick()
    return {
      close: async (): Promise<void> => {
        registration.closed = true
        this.workers.delete(name)
      },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.workers.clear()
    this.pending.clear()
    this.knownIds.clear()
    // 等在跑的那一轮真正退出，避免 close() 之后还有一个游离的 pumpLoop() 在读
    // 已经清空的表（无害，但会在测试里留一个悬空的 in-flight promise）。
    await this.pumpChain.catch(() => {})
  }

  /**
   * 把当前所有到期任务跑完（含重试等待）。
   *
   * 测试里用它代替「等一会儿」——`await driver.drain()` 之后队列一定是静止的，
   * 不需要 `setTimeout(..., 500)` 这种会在 CI 上偶发失败的写法。
   *
   * 实现上不自己跑一个独立的消费循环，而是跟 `add()`/`startWorker()` 共用同一条
   * `pumpChain`：`kick()` 只是把「再跑一轮」接到链尾，`drain()` 等的正是这条链，
   * 所以不会跟并发的 `add()` 抢着读 `pending`。
   */
  async drain(maxRounds = 1000): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      this.kick()
      await this.pumpChain
      if (!this.hasFuture()) return
      await sleepUntilNext(this.earliestReadyAt())
    }
  }

  /** 把「再跑一轮 `pumpLoop()`」接到 `pumpChain` 链尾。同步操作，不建立第二条链。 */
  private kick(): void {
    if (this.closed) return
    // 无论前一棒成功还是失败都要继续跑下一棒，否则一次意外的 reject 会永久卡住
    // 后面所有 add()/drain() 的等待。
    this.pumpChain = this.pumpChain.then(
      () => this.pumpLoop(),
      () => this.pumpLoop(),
    )
  }

  /** 循环消费直到「当前没有到期任务」为止。`pumpChain` 保证同一时刻只有一份在跑。 */
  private async pumpLoop(): Promise<void> {
    for (;;) {
      if (this.closed) return
      const ran = await this.runOnce()
      if (!ran) return
    }
  }

  private hasFuture(): boolean {
    for (const job of this.pending.values()) {
      if (this.workers.has(job.name)) return true
    }
    return false
  }

  private earliestReadyAt(): number {
    let min = Number.POSITIVE_INFINITY
    for (const job of this.pending.values()) {
      if (this.workers.has(job.name)) min = Math.min(min, job.readyAt)
    }
    return min
  }

  /** 跑一个到期任务；没有可跑的返回 `false`。 */
  private async runOnce(): Promise<boolean> {
    const now = Date.now()
    let target: Pending | undefined
    for (const job of this.pending.values()) {
      if (job.readyAt <= now && this.workers.has(job.name)) {
        target = job
        break
      }
    }
    if (!target) return false

    const registration = this.workers.get(target.name)
    if (!registration || registration.closed) return false

    this.pending.delete(target.id)
    target.attempt += 1
    const driverJob: DriverJob = {
      id: target.id,
      name: target.name,
      envelope: target.envelope,
      attempt: target.attempt,
      maxAttempts: target.maxAttempts,
    }

    try {
      await registration.handler(driverJob)
    } catch (err) {
      if (target.attempt >= target.maxAttempts) {
        await registration.onExhausted(driverJob, err)
      } else {
        target.readyAt = Date.now() + backoffDelayMs(target.backoff, target.attempt)
        this.pending.set(target.id, target)
      }
    }
    return true
  }
}

function sleepUntilNext(readyAt: number): Promise<void> {
  const ms = Math.max(1, Math.min(readyAt - Date.now(), 1000))
  return new Promise((resolve) => {
    // cluster-safe-allow: 内存驱动的重试等待，不是业务调度
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
