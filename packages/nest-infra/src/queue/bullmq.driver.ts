/**
 * `BullMqQueueDriver`：生产用的队列驱动。
 *
 * ## 连接怎么传
 *
 * 传 **连接选项**（`{ host, port, db }`）而不是一个现成的 ioredis 实例：BullMQ 的 worker
 * 用阻塞命令（`BZPOPMIN`）取任务，那条连接在阻塞期间干不了别的事。复用主连接的话，
 * 同一条连接上的限流 `INCR`、锁 `SET NX` 会被阻塞命令堵在后面——表现为「随机的接口变慢」，
 * 而且极难联想到队列。给 BullMQ 选项让它自己开专用连接，是官方推荐也是唯一安全的做法。
 *
 * ## 重试与死信的分工
 *
 * 重试次数与退避交给 BullMQ（它的重试是带持久化的，进程重启不丢）；
 * **尝试次数耗尽之后**才轮到我们的 `DeadLetterService` 落库。
 * 判据是 `job.attemptsMade >= job.opts.attempts`——BullMQ 在 `moveToFailed` 里
 * 已经把 `attemptsMade` 加过 1 了，所以 `failed` 事件里这两个数相等就说明没有下一次了。
 *
 * @packageDocumentation
 */

import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq'
import { isJobEnvelope, type JobEnvelope } from './envelope'
import type {
  DriverAddOptions,
  DriverFailedHandler,
  DriverHandler,
  DriverJob,
  DriverWorker,
  DriverWorkerOptions,
  QueueDriver,
} from './queue-driver'

/** {@link BullMqQueueDriver} 的构造参数。 */
export interface BullMqDriverOptions {
  /** BullMQ 连接。**优先传连接选项对象**，理由见文件头。 */
  connection: ConnectionOptions
  /** BullMQ 自己的 key 前缀（它会拼成 `{prefix}:{queueName}:...`）。 */
  prefix?: string
}

export class BullMqQueueDriver implements QueueDriver {
  readonly kind = 'bullmq'

  // process-local: 本进程持有的 BullMQ 客户端句柄，关停时要逐个 close。
  // 队列数据本身在 Redis 里，这里只是连接池。
  private readonly queues = new Map<string, Queue>()
  // process-local: 同上——本进程起的 worker 句柄。
  private readonly workers = new Map<string, Worker>()

  constructor(private readonly options: BullMqDriverOptions) {}

  async add(name: string, envelope: JobEnvelope, opts: DriverAddOptions): Promise<string> {
    const queue = this.queueOf(name)
    const job = await queue.add(name, envelope, {
      ...(opts.delayMs !== undefined ? { delay: opts.delayMs } : {}),
      ...(opts.jobId !== undefined ? { jobId: opts.jobId } : {}),
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
      ...(opts.backoff !== undefined
        ? { backoff: { type: opts.backoff.type, delay: opts.backoff.delayMs } }
        : {}),
      // 成功的任务留 1000 条、失败的留 5000 条就够排查了，再多是在拿 Redis 内存当日志盘。
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    })
    return String(job.id)
  }

  async startWorker(
    name: string,
    opts: DriverWorkerOptions,
    handler: DriverHandler,
    onExhausted: DriverFailedHandler,
  ): Promise<DriverWorker> {
    const worker = new Worker(
      name,
      async (job: Job): Promise<void> => {
        await handler(toDriverJob(job))
      },
      {
        connection: this.options.connection,
        concurrency: opts.concurrency,
        ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
      },
    )

    worker.on('failed', (job, error) => {
      if (!job) return
      const maxAttempts = job.opts.attempts ?? 1
      if (job.attemptsMade < maxAttempts) return
      // 这里 attemptsMade 已经是「总共尝试了几次」（BullMQ 在 moveToFailed 里加过 1），
      // 不能再走 toDriverJob 的 +1，否则死信里的 attempts 会比真实值多一。
      void onExhausted({ ...toDriverJob(job), attempt: job.attemptsMade }, error)
    })

    this.workers.set(name, worker)
    return {
      close: async (): Promise<void> => {
        this.workers.delete(name)
        await worker.close()
      },
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.close()))
    await Promise.all([...this.queues.values()].map((q) => q.close()))
    this.workers.clear()
    this.queues.clear()
  }

  private queueOf(name: string): Queue {
    const existing = this.queues.get(name)
    if (existing) return existing
    const queue = new Queue(name, {
      connection: this.options.connection,
      ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
    })
    this.queues.set(name, queue)
    return queue
  }
}

function toDriverJob(job: Job): DriverJob {
  const data: unknown = job.data
  if (!isJobEnvelope(data)) {
    // 不是我们发的信封：不猜、不兜底，直接抛。混进未知形状的消息时，
    // 「静默按 undefined 处理」会让 worker 在没有租户上下文的情况下跑业务代码。
    throw new TypeError(
      `[@taizan/nest-infra] 队列 "${job.name}" 收到的消息不是 JobEnvelope（job=${String(job.id)}）`,
    )
  }
  return {
    id: String(job.id),
    name: job.name,
    envelope: data,
    // 处理中 attemptsMade 是「之前失败过几次」，所以 +1 才是「这是第几次」。
    attempt: job.attemptsMade + 1,
    maxAttempts: job.opts.attempts ?? 1,
  }
}
