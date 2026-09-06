/**
 * 事务发件箱（Transactional Outbox）。
 *
 * 解决的是一条很具体的裂缝：**「写库成功但消息丢了」**。
 *
 * ```
 * await prisma.$transaction(async (tx) => {
 *   await tx.order.update(...)      // ① 库里改了
 * })
 * await queue.add('order.paid', ...) // ② 进程在这一行之前挂掉 → 消息永远不会发
 * ```
 *
 * 反过来把入队放事务里也不行：事务回滚了消息却已经发出去了。
 * 发件箱的做法是把「要发的消息」当成业务数据的一部分，**在同一个事务里**写进
 * `OutboxEvent` 表——要么两个都成功，要么两个都回滚。真正的投递交给
 * `OutboxRelay`（一个 `@LeaderCron`）在事务外做，失败了下一轮还会再来。
 *
 * 代价是「至少一次」而不是「恰好一次」：消息可能重复投递，所以**消费端必须幂等**
 * （用 `IdempotencyService` 或 `add({ jobId })`）。
 *
 * @packageDocumentation
 */

import { Injectable } from '@nestjs/common'
import { ulid } from '@taizan/contracts'
import { callOperation } from '@taizan/nest-prisma'
import { currentContext } from '@taizan/nest-core'

/** `OutboxEvent` 在客户端上的属性名（camelCase）。 */
export const OUTBOX_EVENT = 'outboxEvent'

/** 一条待投递事件。 */
export interface OutboxEventInput {
  /** 事件来自哪家店；平台级事件为 `undefined`。 */
  originTenantId?: string
  /** 主题。**直接当队列名用**，所以要和某个 `@JobHandler({ name })` 对得上。 */
  topic: string
  /** 业务 payload（必须可 JSON 化）。 */
  payload: unknown
  /** 最早可投递时刻。不传就是立刻。 */
  availableAt?: Date
}

/** 发件箱行（只列本包用到的列）。 */
export interface OutboxRow {
  id: string
  originTenantId: string | null
  topic: string
  payload: unknown
  attempts: number
}

@Injectable()
export class OutboxService {
  /**
   * 在**业务事务内**写一条待投递事件。
   *
   * @param tx - 事务客户端（`prisma.$transaction` 的回调参数）。
   *   刻意要求显式传进来而不是内部去拿 `PrismaService`：拿到的会是事务外的句柄，
   *   那就完全失去了发件箱的意义，而且这个错误从调用点看不出来。
   */
  async enqueueInTx(tx: object, event: OutboxEventInput): Promise<string> {
    const id = ulid()
    // raw-reason: 平台域基础设施表
    await callOperation(tx, OUTBOX_EVENT, 'create', {
      data: {
        id,
        originTenantId: event.originTenantId ?? currentContext()?.tenantId ?? null,
        topic: event.topic,
        payload: event.payload as unknown,
        status: 'PENDING',
        attempts: 0,
        availableAt: event.availableAt ?? new Date(),
      },
    })
    return id
  }
}
