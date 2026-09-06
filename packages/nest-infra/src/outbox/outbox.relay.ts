/**
 * `OutboxRelay`：把 `OutboxEvent` 里的 PENDING 事件推进队列。
 *
 * 它自己就是一个 `@LeaderCron`——多实例部署时只有一台在投递，
 * 否则同一条事件会被几台实例同时读到、同时入队。
 *
 * 每 5 秒一轮：5 秒的投递延迟对「订单已支付 → 发通知」这类场景是可接受的，
 * 而更短的周期会让这张表的轮询查询变成一个不小的固定开销。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { callOperation, PrismaService } from '@taizan/nest-prisma'
import { LeaderCron } from '../cron/leader-cron.decorator'
import { QueueService } from '../queue/queue.service'
import { INFRA_LOGGER } from '../tokens'
import type { InfraLogger } from '../logging'
import { OUTBOX_EVENT, type OutboxRow } from './outbox.service'

/** 一轮最多投递多少条。 */
export const OUTBOX_BATCH_SIZE = 100

/** 超过这个尝试次数就转 DEAD，等人工处理。 */
export const OUTBOX_MAX_ATTEMPTS = 10

@Injectable()
export class OutboxRelay {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(INFRA_LOGGER) private readonly logger: InfraLogger,
  ) {}

  /** 每 5 秒投递一轮。lockTtl 取 30s，留足一轮跑完的余量。 */
  @LeaderCron({ key: 'outbox-relay', cron: '*/5 * * * * *', lockTtlMs: 30_000, watchdog: true })
  async relay(): Promise<void> {
    await this.drainOnce()
  }

  /**
   * 投递一轮。**测试直接调它**。
   *
   * @returns 成功投递的条数
   */
  async drainOnce(): Promise<number> {
    // raw-reason: 平台域基础设施表
    const rows = (await callOperation(this.prisma.raw as object, OUTBOX_EVENT, 'findMany', {
      // FAILED 也要捞：它表示「本轮失败，等 availableAt 之后重试」（见 07-infra.prisma
      // 的 OutboxStatus 注释）。只查 PENDING 的话，失败一次的事件就永远不会再被投递。
      where: { status: { in: ['PENDING', 'FAILED'] }, availableAt: { lte: new Date() } },
      orderBy: { availableAt: 'asc' },
      take: OUTBOX_BATCH_SIZE,
    })) as OutboxRow[] | null

    if (!rows || rows.length === 0) return 0

    let sent = 0
    for (const row of rows) {
      try {
        await this.queue.add(row.topic, row.payload, {
          ...(row.originTenantId ? { tenantId: row.originTenantId } : {}),
          // 用发件箱行的 id 当 job id：relay 重复读到同一行时（比如上一轮标状态失败了）
          // 队列侧会自然去重，不会真的投两次。
          jobId: `outbox-${row.id}`,
        })
        // raw-reason: 平台域基础设施表
        await callOperation(this.prisma.raw as object, OUTBOX_EVENT, 'update', {
          where: { id: row.id },
          data: { status: 'SENT', attempts: row.attempts + 1 },
        })
        sent += 1
      } catch (err) {
        await this.markFailed(row, err)
      }
    }
    return sent
  }

  private async markFailed(row: OutboxRow, err: unknown): Promise<void> {
    const attempts = row.attempts + 1
    const dead = attempts >= OUTBOX_MAX_ATTEMPTS
    // 指数退避，封顶 5 分钟：一直失败通常是队列整体挂了，退避太慢也没用。
    const delayMs = Math.min(5 * 60_000, 1000 * Math.pow(2, attempts))
    this.logger.error(
      `[@taizan/nest-infra] 发件箱投递失败（id=${row.id}, topic=${row.topic}, 第 ${attempts} 次）：` +
        (err instanceof Error ? err.message : String(err)),
      err instanceof Error ? err.stack : undefined,
      'OutboxRelay',
    )
    try {
      // raw-reason: 平台域基础设施表
      await callOperation(this.prisma.raw as object, OUTBOX_EVENT, 'update', {
        where: { id: row.id },
        data: {
          status: dead ? 'DEAD' : 'FAILED',
          attempts,
          availableAt: new Date(Date.now() + delayMs),
        },
      })
    } catch {
      // 连状态都写不进去说明库也挂了，下一轮 relay 会重新读到这一行。
    }
  }
}
