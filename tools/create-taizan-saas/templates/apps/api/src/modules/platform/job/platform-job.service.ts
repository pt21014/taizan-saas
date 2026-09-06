/**
 * `/api/platform/jobs` —— 队列死信查看/重放 + cron 运行记录（T3-4 任务书条目②）。
 *
 * ## 为什么这里不给 `@taizan/nest-infra` 加 `DeadLetterService.list()`
 *
 * 任务边界只许改 `apps/api/src/modules/platform/{auth,job,dashboard}/**`，
 * `packages/nest-infra` 不在允许改动范围内。`DeadLetterService` 已经有
 * `record()`/`replay()`，唯独没有分页查询——这里直接用
 * `RawPrismaService` 查 `JobDeadLetter`/`CronRun` 两张表（都是平台域基础设施表，
 * `src/tenancy/raw-reasons.ts` 里 `src/modules/platform/` 整目录已经豁免），
 * **重放**仍然调用 `DeadLetterService.replay()`（真正的重入队逻辑不重写第二遍）。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { normalizePage, type PageResult } from '@taizan/contracts'
import { DeadLetterService } from '@taizan/nest-infra'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type { ListCronRunsQueryDto, ListDeadLettersQueryDto } from './dto/platform-job.dto'

/** 下发给平台后台的一条死信。 */
export interface DeadLetterView {
  id: string
  queue: string
  jobName: string
  originTenantId: string | null
  attempts: number
  lastError: string
  traceId: string
  createdAt: string
  resolvedAt: string | null
}

/** 下发给平台后台的一条 cron 运行记录。 */
export interface CronRunView {
  id: string
  key: string
  startedAt: string
  finishedAt: string | null
  instanceId: string
  ok: boolean
  error: string | null
}

/** 一行 `JobDeadLetter`（Prisma 生成的行类型）。 */
type DeadLetterRow = NonNullable<
  Awaited<ReturnType<AppPrismaClient['jobDeadLetter']['findUnique']>>
>

/** 一行 `CronRun`。 */
type CronRunRow = NonNullable<Awaited<ReturnType<AppPrismaClient['cronRun']['findUnique']>>>

function toDeadLetterView(row: DeadLetterRow): DeadLetterView {
  return {
    id: row.id,
    queue: row.queue,
    jobName: row.jobName,
    originTenantId: row.originTenantId,
    attempts: row.attempts,
    lastError: row.lastError,
    traceId: row.traceId,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }
}

function toCronRunView(row: CronRunRow): CronRunView {
  return {
    id: row.id,
    key: row.key,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    instanceId: row.instanceId,
    ok: row.ok,
    error: row.error,
  }
}

@Injectable()
export class PlatformJobService {
  constructor(
    // raw-reason: 平台域基础设施表——JobDeadLetter / CronRun 都在 07-infra.prisma，
    // 读者是无人值守的后台进程，没有租户上下文。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(DeadLetterService) private readonly deadLetters: DeadLetterService,
  ) {}

  /** 死信列表：分页 + 按 queue / resolved 筛。 */
  async listDeadLetters(query: ListDeadLettersQueryDto): Promise<PageResult<DeadLetterView>> {
    const { page, pageSize } = normalizePage(query)
    const where = {
      ...(query.queue ? { queue: query.queue } : {}),
      ...(query.resolved === true
        ? { resolvedAt: { not: null } }
        : query.resolved === false
          ? { resolvedAt: null }
          : {}),
    }

    // raw-reason: 平台域基础设施表——分页列表，带 take，不是全表扫描。
    const [rows, total] = await Promise.all([
      this.raw.client.jobDeadLetter.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      // raw-reason: 平台域基础设施表。
      this.raw.client.jobDeadLetter.count({ where }),
    ])
    return { items: rows.map(toDeadLetterView), total, page, pageSize }
  }

  /**
   * 重放一条死信。真正的重入队逻辑在 `@taizan/nest-infra` 的 `DeadLetterService.replay()`
   * 里——失败会抛 `BizException(ErrorCode.JOB_REPLAY_FAILED)`（1850000），这里不吞、
   * 不二次包装，原样让它冒泡给控制器。
   *
   * @returns 重放之后在队列里的新 job id
   */
  async replay(id: string): Promise<{ jobId: string }> {
    const jobId = await this.deadLetters.replay(id)
    return { jobId }
  }

  /** cron 运行记录：最近的在前，供运维核对 leader 锁是否正常（有没有实例在跑、跑没跑成）。 */
  async listCronRuns(query: ListCronRunsQueryDto): Promise<PageResult<CronRunView>> {
    const { page, pageSize } = normalizePage(query)
    const where = {
      ...(query.key ? { key: query.key } : {}),
      ...(query.outcome === 'ok' ? { ok: true } : query.outcome === 'failed' ? { ok: false } : {}),
    }

    // raw-reason: 平台域基础设施表——分页列表，带 take，不是全表扫描。
    const [rows, total] = await Promise.all([
      this.raw.client.cronRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      // raw-reason: 平台域基础设施表。
      this.raw.client.cronRun.count({ where }),
    ])
    return { items: rows.map(toCronRunView), total, page, pageSize }
  }
}
