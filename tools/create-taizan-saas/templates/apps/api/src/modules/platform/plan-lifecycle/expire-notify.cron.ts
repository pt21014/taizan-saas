/**
 * 到期提醒 cron（T2-7，蓝图 §4.6）：T-7/T-3/T-1/T+0/T+3 五档，leader 锁 + 当天幂等。
 *
 * ## 为什么按 `Tenant.status` 分页扫，不查 `PlatformGateway`
 *
 * 闸门（`PlatformGateway`）是「回答某一个租户此刻能不能写」的**热路径**缓存，
 * 不是给「把全体租户过一遍」这种冷路径批量任务用的——30 秒的进程内缓存对单个请求
 * 没问题，对一次要扫几千个租户的 cron 反而会算出过期的 `daysLeft`。到期闸门的判定
 * 函数本身（`evaluateTenantGate`）是纯函数，cron 直接拿它算，不经过缓存层。
 *
 * ## 幂等键为什么含 `stage`，为什么续费后当天不再提醒
 *
 * `notify:plan-expire:{tenantId}:{stage}:{yyyymmdd}`——`stage` 由 `daysLeft` 反查
 * （`resolveExpireStage`），续费之后 `planExpireAt` 被 `PlanOrderService.fulfill()`
 * 推远，`daysLeft` 随之变成一个不在五档上的数字，`resolveExpireStage` 直接返回
 * `null`，这个租户**在 `matched` 那一步就被跳过**，根本不会走到幂等判断——不是
 * 「幂等键把重复的请求挡住了」，而是「今天已经不再是任何一个提醒档位了」。
 *
 * ## 为什么分页扫、不用一次 `findMany()` 把全表读进内存
 *
 * 与 `PlanOrderService.cancelExpired()` 的取舍相反：那边是一条 `updateMany`（不需要
 * 逐行读），这边每个租户都要单独判定 `daysLeft` 并可能发通知，逃不开逐行处理，
 * 所以用**游标分页**（`take` + `cursor`）而不是一次性 `findMany()`——几万个租户的库上，
 * 后者会把内存吃光，也会让一次 tick 占着数据库连接太久。
 *
 * ## 单个租户失败不该拖垮整批
 *
 * 每个租户的处理都包在 try/catch 里：一家店的店主账号数据异常、通知模板配置错误，
 * 不该让后面几千家店都收不到提醒——那种「一颗老鼠屎摧毁一锅粥」的写法在批量任务里
 * 尤其致命。异常计入 `outcome.errors` 并打 error 日志，cron 本身仍然算成功
 * （`CronRun.ok=true`），除非游标分页那一层的数据库查询本身失败。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, Optional } from '@nestjs/common'
import { evaluateTenantGate } from '@taizan/billing-rules'
import { AppLogger, runWithPatchedContext } from '@taizan/nest-core'
import { IdempotencyService, LeaderCron } from '@taizan/nest-infra'
import { NotifyService } from '@taizan/nest-notify'
import { RawPrismaService } from '@taizan/nest-prisma'
import { planExpireInboxKey, planExpireSmsKey } from '@taizan/prisma-base'

import type { AppPrismaClient } from '../../../common/prisma.types'
import {
  PLAN_EXPIRE_NOTIFY_SCOPE,
  planExpireIdempotencyKey,
  resolveExpireStage,
  type PlanExpireStage,
} from './plan-lifecycle.rules'

const CONTEXT = 'ExpireNotifyCron'

/** 一次分页取多少个租户。 */
const PAGE_SIZE = 200

/** 一次 cron tick 的产出，供测试与运维台断言。 */
export interface ExpireNotifyOutcome {
  /** 扫过的 ACTIVE/TRIAL 租户数。 */
  scanned: number
  /** 命中某个到期提醒档位的租户数。 */
  matched: number
  /** 真的发起了一次提醒（幂等命中「新」）的租户数。 */
  sent: number
  /** 命中档位但今天已经发过（幂等命中「旧」）的租户数。 */
  skippedIdempotent: number
  /** 单个租户处理失败的次数（不影响其它租户）。 */
  errors: number
}

/** 扫描时选的那点租户信息。 */
interface ExpireCandidate {
  id: string
  name: string
  status: string
  planExpireAt: Date | null
  trialEndAt: Date | null
  graceDays: number
  ownerAccountId: string
}

@Injectable()
export class ExpireNotifyCron {
  constructor(
    // raw-reason: 平台域 cron 跨租户——到期提醒要扫全体 ACTIVE/TRIAL 租户，
    // 不属于任何单一租户上下文，`Tenant` 本身也是没有 tenantId 列的平台域表。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional() @Inject(NotifyService) private readonly notify?: NotifyService,
  ) {}

  @LeaderCron({
    key: 'plan-expire-notify',
    cron: '0 9 * * *',
    lockTtlMs: 300_000,
    watchdog: true,
    timezone: 'Asia/Shanghai',
  })
  async run(now: Date = new Date()): Promise<ExpireNotifyOutcome> {
    const outcome: ExpireNotifyOutcome = {
      scanned: 0,
      matched: 0,
      sent: 0,
      skippedIdempotent: 0,
      errors: 0,
    }
    let cursor: string | undefined

    for (;;) {
      // raw-reason: 平台域 cron 跨租户，分页不全表（见文件头）。
      const page = await this.raw.client.tenant.findMany({
        where: { status: { in: ['ACTIVE', 'TRIAL'] } },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          name: true,
          status: true,
          planExpireAt: true,
          trialEndAt: true,
          graceDays: true,
          ownerAccountId: true,
        },
      })
      if (page.length === 0) break
      cursor = page[page.length - 1]?.id

      for (const tenant of page) {
        outcome.scanned += 1
        try {
          await this.processTenant(tenant, now, outcome)
        } catch (err) {
          outcome.errors += 1
          this.logger.error(
            `到期提醒处理失败（租户 ${tenant.id}）：${messageOf(err)}`,
            err instanceof Error ? err.stack : undefined,
            CONTEXT,
          )
        }
      }
    }

    if (outcome.matched > 0 || outcome.errors > 0) {
      this.logger.log(
        `到期提醒 cron：扫描 ${outcome.scanned} 家、命中档位 ${outcome.matched} 家、` +
          `实际发送 ${outcome.sent} 家、幂等跳过 ${outcome.skippedIdempotent} 家、失败 ${outcome.errors} 家`,
        CONTEXT,
      )
    }
    return outcome
  }

  private async processTenant(
    tenant: ExpireCandidate,
    now: Date,
    outcome: ExpireNotifyOutcome,
  ): Promise<void> {
    // 这里只要 daysLeft/phase 现算的结果，不判定放不放行——`enforcing` 传什么都不影响
    // daysLeft 本身（见 `@taizan/billing-rules` 的 `evaluateTenantGate`），到期提醒
    // 不应该因为 `BILLING_ENFORCE=false`（只是不真拦）就连提醒都不发了。
    const gate = evaluateTenantGate({
      now,
      status: tenant.status as 'ACTIVE' | 'TRIAL' | 'SUSPENDED' | 'DEREGISTERED',
      planExpireAt: tenant.planExpireAt,
      trialEndAt: tenant.trialEndAt,
      graceDays: tenant.graceDays,
      enforcing: false,
    })
    const stage = resolveExpireStage(gate.daysLeft)
    if (!stage) return
    outcome.matched += 1

    const key = planExpireIdempotencyKey(tenant.id, stage, now)
    const { fresh } = await this.idempotency.run(PLAN_EXPIRE_NOTIFY_SCOPE, key, async () => {
      await this.sendReminder(tenant, stage, gate.daysLeft ?? 0, now)
      return true
    })
    if (fresh) outcome.sent += 1
    else outcome.skippedIdempotent += 1
  }

  /**
   * 发给店主：INBOX + SMS 各一次（广播，不是降级——两条通道各自独立尝试）。
   *
   * `runWithPatchedContext({ tenantId })`：cron 本身没有租户上下文，`NotifyRecord`
   * 是租户域表，写库要靠隔离扩展从上下文取 `tenantId`（与 `plan-order.service.ts`
   * 发站内信同一个理由）。
   */
  private async sendReminder(
    tenant: ExpireCandidate,
    stage: PlanExpireStage,
    daysLeft: number,
    now: Date,
  ): Promise<void> {
    if (!this.notify) return
    // raw-reason: 平台域 cron——按 ownerAccountId 取店主的手机号，短信要用。
    const owner = await this.raw.client.staffAccount.findUnique({
      where: { id: tenant.ownerAccountId },
    })
    const expireAt = (tenant.planExpireAt ?? tenant.trialEndAt ?? now).toISOString().slice(0, 10)
    const vars = { shopName: tenant.name, expireAt, daysLeft: String(Math.abs(daysLeft)) }

    await runWithPatchedContext({ tenantId: tenant.id }, async () => {
      try {
        await this.notify?.send({
          tenantId: tenant.id,
          templateKey: planExpireInboxKey(stage),
          to: { userId: tenant.ownerAccountId },
          channels: ['INBOX'],
          vars,
        })
      } catch (err) {
        this.logger.warn(
          `到期提醒站内信发送失败（租户 ${tenant.id}，档位 ${stage}）：${messageOf(err)}`,
          CONTEXT,
        )
      }

      if (!owner?.phone) return
      try {
        await this.notify?.send({
          tenantId: tenant.id,
          templateKey: planExpireSmsKey(stage),
          to: { phone: owner.phone },
          channels: ['SMS'],
          vars,
        })
      } catch (err) {
        this.logger.warn(
          `到期提醒短信发送失败（租户 ${tenant.id}，档位 ${stage}）：${messageOf(err)}`,
          CONTEXT,
        )
      }
    })
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
