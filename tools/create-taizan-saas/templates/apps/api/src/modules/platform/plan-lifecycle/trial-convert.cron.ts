/**
 * 试用转化 cron（T2-7，蓝图 §4.6）。
 *
 * ## 两种实现二选一，本文件选的是「默认不转化，靠闸门现算打烊」，
 * ## 并在配置了 `SIGNUP_TRIAL_AUTO_PLAN` 时额外支持「自动挂免费套餐」
 *
 * 蓝图给了两条路：
 *
 * 1. **默认（`SIGNUP_TRIAL_AUTO_PLAN` 不配）**：试用到期后租户**保持 `TRIAL`**，
 *    什么都不改——`evaluateTenantGate` 对 `TRIAL` 租户按 `trialEndAt` 现算，过了就
 *    后台只读、C 端打烊，续费白名单仍可写。这正是蓝图 §4.6「到期永远现算，不落状态」
 *    那条不可退让在试用场景下的样子，本 cron 这一分支不写一行数据库。
 * 2. **配了 `SIGNUP_TRIAL_AUTO_PLAN`**：把试用到期、还没转化过的租户「0 元续」到
 *    这档免费套餐上——**必须走 `PlanOrderService.create()` + `fulfill()`**，
 *    不能自己 `tenant.update({ data: { planExpireAt: ... } })`：`Tenant.planExpireAt`
 *    的写入只允许出现在 `plan-order.service.ts`（`test/arch/plan-order-fulfill.spec.ts`
 *    扫源码盯着），绕过它去自己写就是给收费闭环开了第二条实现。走 `fulfill()` 还顺带
 *    拿到了它自带的一切：`TRIAL → ACTIVE`、审计、站内信、`PlatformGateway.invalidate()`。
 *
 * ## 为什么不是「二选一写两份代码」而是「一份代码、两条分支」
 *
 * 两条路唯一的差别就是「配没配 `SIGNUP_TRIAL_AUTO_PLAN`」，本质是同一个 cron 的两种
 * 运行结果，不是两套互斥的架构——运营随时可以在平台后台上线一个免费套餐、配上这个
 * env，把默认行为切换成自动转化，不需要重新部署代码。
 *
 * ## 已知未覆盖 / 不完美的地方
 *
 * `PlanOrder.operatorId`/审计的 `actorId` 语义上是「操作人」（`PlatformAdmin.id`），
 * 这里传的是固定哨兵字符串 `cron:trial-convert`——数据库没有为它加外键约束，
 * 但平台后台如果哪天想显示「操作人姓名」，遇到这个值会查不到对应的管理员。
 * 这是本任务认下来的一个不完美，不是遗漏：新增一个「SYSTEM 触发」的 via 枚举值
 * 需要改 `plan-order.service.ts` 与它的状态机/审计标签，超出 T2-7 的范围。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, ConfigService } from '@taizan/nest-core'
import { LeaderCron } from '@taizan/nest-infra'
import { RawPrismaService } from '@taizan/nest-prisma'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type { AppEnv } from '../../../config/env'
import { PlanOrderService } from '../plan-order/plan-order.service'

const CONTEXT = 'TrialConvertCron'

/** 一次分页取多少个租户。 */
const PAGE_SIZE = 200

/**
 * `PlanOrder.operatorId` / 审计 `actorId` 用的哨兵值——见文件头「已知未覆盖」。
 * 不是真实的 `PlatformAdmin.id`。
 */
export const AUTO_CONVERT_OPERATOR_ID = 'cron:trial-convert'

/** 一次 cron tick 的产出，供测试与运维台断言。 */
export interface TrialConvertOutcome {
  /** `SIGNUP_TRIAL_AUTO_PLAN` 这次跑的时候是不是配了。 */
  autoPlanConfigured: boolean
  /** 命中「TRIAL 且已过 trialEndAt」条件、进入自动转化候选的租户数。 */
  scanned: number
  /** 真的自动转化成功的租户数。 */
  converted: number
  /** 单个租户转化失败的次数（不影响其它租户）。 */
  errors: number
}

@Injectable()
export class TrialConvertCron {
  constructor(
    // raw-reason: 平台域 cron 跨租户——扫描试用到期的租户、按 code 找自动挂靠的套餐，
    // `Tenant`/`Plan` 都是没有 tenantId 列的平台域表。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(ConfigService) private readonly config: ConfigService<AppEnv>,
    @Inject(PlanOrderService) private readonly planOrders: PlanOrderService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @LeaderCron({
    key: 'trial-convert',
    cron: '30 9 * * *',
    lockTtlMs: 300_000,
    timezone: 'Asia/Shanghai',
  })
  async run(now: Date = new Date()): Promise<TrialConvertOutcome> {
    const autoPlanCode = this.config.get('SIGNUP_TRIAL_AUTO_PLAN')?.trim()
    const outcome: TrialConvertOutcome = {
      autoPlanConfigured: Boolean(autoPlanCode),
      scanned: 0,
      converted: 0,
      errors: 0,
    }

    if (!autoPlanCode) {
      // 选择①（默认）：不自动转化，见文件头。不写一行数据库。
      return outcome
    }

    // raw-reason: 平台域 cron——按 code 找自动挂靠的免费套餐。
    const plan = await this.raw.client.plan.findUnique({ where: { code: autoPlanCode } })
    if (!plan || plan.status !== 'ENABLED') {
      this.logger.warn(
        `SIGNUP_TRIAL_AUTO_PLAN=${autoPlanCode} 找不到对应的在售套餐，本轮跳过自动转化`,
        CONTEXT,
      )
      return outcome
    }
    if (plan.firstPriceCents !== 0) {
      // 防呆：这条 cron 只做「免费套餐自动挂」，配错成一档收费套餐的话，会在没有
      // 任何实际收款的情况下把它标成「已兑现」——那是一条会在对账时爆炸的假流水。
      this.logger.warn(
        `SIGNUP_TRIAL_AUTO_PLAN=${autoPlanCode} 的 firstPriceCents=${String(plan.firstPriceCents)}，` +
          '不是免费套餐，本轮跳过自动转化（自动转化只能配免费套餐）',
        CONTEXT,
      )
      return outcome
    }

    let cursor: string | undefined
    for (;;) {
      // raw-reason: 平台域 cron 跨租户，分页不全表（与 expire-notify.cron.ts 同一取舍）。
      // `OR: [{ planId: null }, { planId: { not: plan.id } }]` 是双保险（转化成功后
      // status 会变成 ACTIVE，天然就不再落进 `status: 'TRIAL'` 这个条件了），**不能写成**
      // `planId: { not: plan.id }`——SQL 的三值逻辑下 `<> x` 对 `NULL` 永远不成立，
      // 会把「从没挂过任何套餐」（`planId` 恰好是 `null`，也是最常见的试用租户）的那些
      // 整批过滤掉，`outcome.scanned` 会静默变成 0（这是本任务在 e2e 里踩到的真实 bug）。
      const page = await this.raw.client.tenant.findMany({
        where: {
          status: 'TRIAL',
          trialEndAt: { lt: now },
          OR: [{ planId: null }, { planId: { not: plan.id } }],
        },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: { id: true },
      })
      if (page.length === 0) break
      cursor = page[page.length - 1]?.id

      for (const tenant of page) {
        outcome.scanned += 1
        try {
          await this.autoAttach(tenant.id, plan.id, now)
          outcome.converted += 1
        } catch (err) {
          outcome.errors += 1
          this.logger.error(
            `试用自动转化失败（租户 ${tenant.id}）：${messageOf(err)}`,
            err instanceof Error ? err.stack : undefined,
            CONTEXT,
          )
        }
      }
    }

    if (outcome.scanned > 0) {
      this.logger.log(
        `trial-convert：扫描 ${outcome.scanned} 家试用到期租户、自动转化 ${outcome.converted} 家、` +
          `失败 ${outcome.errors} 家（套餐 ${autoPlanCode}）`,
        CONTEXT,
      )
    }
    return outcome
  }

  /**
   * 选择②：把一家试用到期的租户「0 元续」到配置的免费套餐上。
   *
   * 老老实实走 `create()` + `fulfill()`（理由见文件头），不自己碰 `Tenant` 的任何字段。
   */
  private async autoAttach(tenantId: string, planId: string, now: Date): Promise<void> {
    const order = await this.planOrders.create({
      tenantId,
      planId,
      periods: 1,
      channel: 'OFFLINE',
      operatorId: AUTO_CONVERT_OPERATOR_ID,
    })
    await this.planOrders.fulfill(order.id, {
      paidAt: now,
      via: 'OFFLINE',
      operatorId: AUTO_CONVERT_OPERATOR_ID,
    })
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
