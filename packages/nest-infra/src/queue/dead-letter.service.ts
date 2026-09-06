/**
 * `DeadLetterService`：尝试次数耗尽的任务落 `JobDeadLetter`，以及人工重放。
 *
 * 队列失败重试到底还是会用完。用完之后有两种做法：
 * 让消息留在 BullMQ 的 failed 集合里（默认），或者落一张自己的表。
 * 我们选后者，因为：
 *
 * - failed 集合会被 `removeOnFail` 按条数裁掉，而「三天前那笔分账为什么没发」
 *   往往是三天后才有人问；
 * - 平台后台要能按租户、按队列筛，还要记「谁在什么时候重放过」（`resolvedAt`）；
 * - Redis 是可以被 flush 的，业务数据不该只存在那里。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode, ulid } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import { callOperation, PrismaService } from '@taizan/nest-prisma'
import { isJobEnvelope, type JobEnvelope } from './envelope'
import { QueueService } from './queue.service'
import { INFRA_LOGGER } from '../tokens'
import type { InfraLogger } from '../logging'

/** `JobDeadLetter` 在客户端上的属性名（camelCase）。 */
const JOB_DEAD_LETTER = 'jobDeadLetter'

/** 落一条死信要的信息。 */
export interface DeadLetterEntry {
  /** 队列名。 */
  queue: string
  /** 任务名。 */
  jobName: string
  /** 归属租户；平台级任务为 `undefined`。字段名与表一致，见 `07-infra.prisma` 文件头。 */
  originTenantId?: string
  /** 原始信封（整个存下来，重放时要原样用）。 */
  payload: JobEnvelope
  /** 一共尝试了几次。 */
  attempts: number
  /** 最后一次失败的原因。 */
  lastError: unknown
  /** 最后一次执行的 traceId。 */
  traceId: string
}

/** 死信行（只列本包会用到的列）。 */
export interface DeadLetterRow {
  id: string
  queue: string
  jobName: string
  originTenantId: string | null
  payload: unknown
  attempts: number
  lastError: string
  traceId: string
  resolvedAt: Date | null
}

@Injectable()
export class DeadLetterService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(INFRA_LOGGER) private readonly logger: InfraLogger,
  ) {}

  /**
   * 落一条死信。
   *
   * 写失败**不抛**（这里已经是最后一道兜底了，再抛也没人接），但会打 error——
   * 「死信都记不上」是必须有人知道的事。
   */
  async record(entry: DeadLetterEntry): Promise<string | null> {
    const id = ulid()
    try {
      // raw-reason: 平台域基础设施表
      await callOperation(this.prisma.raw as object, JOB_DEAD_LETTER, 'create', {
        data: {
          id,
          queue: entry.queue,
          jobName: entry.jobName,
          originTenantId: entry.originTenantId ?? null,
          // Prisma 的 Json 列要能被序列化：信封里只允许放可 JSON 化的东西。
          payload: entry.payload as unknown,
          attempts: entry.attempts,
          lastError: messageOf(entry.lastError).slice(0, 8000),
          traceId: entry.traceId,
        },
      })
      this.logger.error(
        `[@taizan/nest-infra] job "${entry.jobName}" 重试 ${entry.attempts} 次后进死信（id=${id}）：` +
          messageOf(entry.lastError),
        undefined,
        'DeadLetterService',
      )
      return id
    } catch (err) {
      this.logger.error(
        `[@taizan/nest-infra] 写 JobDeadLetter 失败（job=${entry.jobName}）：${messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
        'DeadLetterService',
      )
      return null
    }
  }

  /**
   * 重放一条死信：原样重新入队，并标 `resolvedAt`。
   *
   * **先入队再标记**。反过来的话，入队失败时这条死信已经被标成「已处理」，
   * 于是它既没被执行也不会再出现在待办列表里——彻底消失。
   *
   * @throws `BizException`（`1850000` 任务重放失败）——找不到记录，或记录里的 payload 不是合法信封。
   *   用 500 语义而不是 404：重放按钮上的 id 是从死信列表里带过来的，走到这一步还找不到、
   *   或者 payload 存坏了，都说明是我们这边的数据出了问题，不是操作者点错了。
   */
  async replay(id: string): Promise<string> {
    // raw-reason: 平台域基础设施表
    const row = (await callOperation(this.prisma.raw as object, JOB_DEAD_LETTER, 'findUnique', {
      where: { id },
    })) as DeadLetterRow | null

    if (!row) {
      throw new BizException(ErrorCode.JOB_REPLAY_FAILED, `[@taizan/nest-infra] 死信 ${id} 不存在`)
    }
    const payload: unknown = typeof row.payload === 'string' ? safeParse(row.payload) : row.payload
    if (!isJobEnvelope(payload)) {
      throw new BizException(
        ErrorCode.JOB_REPLAY_FAILED,
        `[@taizan/nest-infra] 死信 ${id} 的 payload 不是 JobEnvelope，无法重放`,
      )
    }

    const jobId = await this.queue.replayEnvelope(row.jobName, payload)

    // raw-reason: 平台域基础设施表
    await callOperation(this.prisma.raw as object, JOB_DEAD_LETTER, 'update', {
      where: { id },
      data: { resolvedAt: new Date() },
    })
    return jobId
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : JSON.stringify(err)
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
