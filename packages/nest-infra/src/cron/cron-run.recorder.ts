/**
 * `CronRunRecorder`：把每次 leader tick 落到 `CronRun` 表。
 *
 * 这张表是 leader 锁**唯一的可观测面**。没有它，「4 个实例是不是真的只跑了一个」
 * 这个问题只能靠翻日志猜；有了它，`select key, count(*) from "CronRun"
 * where "startedAt" > ... group by 1` 一眼就能看出有没有并发。
 * 验收里那条「同一 tick 只有一条 CronRun」也正是查这张表。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ulid } from '@taizan/contracts'
import { callOperation, PrismaService } from '@taizan/nest-prisma'
import { INFRA_LOGGER } from '../tokens'
import type { InfraLogger } from '../logging'

/** `CronRun` 在客户端上的属性名（camelCase）。 */
const CRON_RUN = 'cronRun'

@Injectable()
export class CronRunRecorder {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(INFRA_LOGGER) private readonly logger: InfraLogger,
  ) {}

  /**
   * 开始一次执行，返回记录 id。
   *
   * 写失败**不抛**：cron 本身的执行比它的执行记录重要，不能因为记不上账就不干活。
   * 但也**不吞**——打 error 日志，返回 `null` 让 {@link CronRunRecorder.finish} 跳过收尾。
   */
  async start(key: string, instanceId: string): Promise<string | null> {
    const id = ulid()
    try {
      // raw-reason: 平台域基础设施表
      await callOperation(this.prisma.raw as object, CRON_RUN, 'create', {
        data: { id, key, instanceId, startedAt: new Date(), ok: false },
      })
      return id
    } catch (err) {
      this.logger.error(
        `[@taizan/nest-infra] 写 CronRun 起始记录失败（key=${key}）：${messageOf(err)}`,
        stackOf(err),
        'CronRunRecorder',
      )
      return null
    }
  }

  /** 收尾：写 `finishedAt` / `ok` / `error`。 */
  async finish(id: string | null, ok: boolean, error?: unknown): Promise<void> {
    if (id === null) return
    try {
      // raw-reason: 平台域基础设施表
      await callOperation(this.prisma.raw as object, CRON_RUN, 'update', {
        where: { id },
        data: {
          finishedAt: new Date(),
          ok,
          // 只留消息不留整个 stack：这一列是给运维扫一眼用的，完整 stack 在日志里。
          error: ok ? null : messageOf(error).slice(0, 2000),
        },
      })
    } catch (err) {
      this.logger.error(
        `[@taizan/nest-infra] 写 CronRun 收尾记录失败（id=${id}）：${messageOf(err)}`,
        stackOf(err),
        'CronRunRecorder',
      )
    }
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : JSON.stringify(err)
}

function stackOf(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined
}
