/**
 * **到期提醒 cron + 试用转化 + 保留期清理 e2e**（T2-7，蓝图 §4.6）—— 真 MySQL + Redis。
 *
 * ```
 * pnpm dev:infra
 * pnpm -F @taizan/api prisma:migrate
 * pnpm -F @taizan/api test:e2e
 * ```
 *
 * 租户/员工都直接用原始 `PrismaClient` 造（不经 `/api/platform/tenants`）：本文件
 * 只测 cron 本身怎么读、怎么发、幂等键怎么算，跟「建店那条 HTTP 链路对不对」是两件事
 * （那条链路已经被 `tenant-isolation.e2e-spec.ts` 等文件覆盖），跳过登录也省下宝贵的
 * `login` 限流额度（多个 e2e 文件共用同一个桶，见 `plan-order.e2e-spec.ts` 的说明）。
 *
 * ## 用例清单
 *
 * | # | 断言 |
 * |---|---|
 * | ① | 租户到期日设为 3 天后 → 手动触发一次 → 店主收到一条 INBOX（`NotifyRecord.channel==='IN_APP'`）+ 一条 SMS；再触发一次 → 不重复 |
 * | ② | 3 个 app 实例同时触发同一个 tick → `CronRun` 同一 key 只一条、通知只一条 |
 * | ③ | 走 `PlanOrderService` 续费之后再触发 → 不再提醒（daysLeft 已经不落在任何档位上） |
 * | ④ | 到期后 3 天（`daysLeft=-3`）命中 `+3` 档位 |
 * | ⑤ | `retention` 列出超期的 `DEREGISTERED` 租户，但库里 `Tenant` 行数不变 |
 * | ⑥ | `trial-convert`：默认不转化（保持 TRIAL，不写库）；配了 `SIGNUP_TRIAL_AUTO_PLAN` 时通过 `PlanOrderService` 的统一 fulfill 路径自动转化 |
 *
 * @packageDocumentation
 */

import 'reflect-metadata'
import 'dotenv/config'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import { addCalendarDays, calendarDayOf, endOfCalendarDay } from '@taizan/billing-rules'
import { ulid } from '@taizan/contracts'
import { ENV } from '@taizan/nest-core'
import {
  CronRegistry,
  CronScheduler,
  runInFreshContext,
  type LeaderCronDefinition,
} from '@taizan/nest-infra'
import { hashPassword, planExpireInboxKey, planExpireSmsKey, seedBase } from '@taizan/prisma-base'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../src/bootstrap/app.module'
import { configureApp } from '../src/bootstrap/configure-app'
import { APP_ENV_SCHEMA } from '../src/config/env'
import { ExpireNotifyCron } from '../src/modules/platform/plan-lifecycle/expire-notify.cron'
import { listOverdueTenants } from '../src/modules/platform/plan-lifecycle/retention.cli'
import {
  AUTO_CONVERT_OPERATOR_ID,
  TrialConvertCron,
} from '../src/modules/platform/plan-lifecycle/trial-convert.cron'
import { PlanOrderService } from '../src/modules/platform/plan-order/plan-order.service'
import { findFirstUpsertDelegate } from '../src/seed-delegates'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

const RUN = ulid().slice(-8).toLowerCase()
const OWNER_PASSWORD = 'e2e-lifecycle-pw-123'
const PHONE_BASE = [...RUN]
  .map((c) => c.charCodeAt(0) % 10)
  .join('')
  .slice(0, 6)

function phoneFor(n: number): string {
  return `137${PHONE_BASE}${String(n).padStart(2, '0')}`
}

let app: INestApplication
let prisma: PrismaClient
let planOrders: PlanOrderService
let expireNotify: ExpireNotifyCron
let trialConvert: TrialConvertCron
let planId = ''
let ownerPasswordHash = ''
let phoneCounter = 0

/** `Plan.firstPriceCents`/`renewPriceCents` 都非 0，用来测「续费」。 */
const FIRST_PRICE_CENTS = 9900
const RENEW_PRICE_CENTS = 4900
const PERIOD_MONTHS = 1

/** 直接建一个 `StaffAccount`，回它的 id 与手机号——本文件不用登录，只要有效的店主账号。 */
async function createOwnerAccount(): Promise<{ id: string; phone: string }> {
  phoneCounter += 1
  const phone = phoneFor(phoneCounter)
  const account = await prisma.staffAccount.create({
    data: {
      id: ulid(),
      phone,
      passwordHash: ownerPasswordHash,
      name: `店主 ${String(phoneCounter)}`,
      status: 'ACTIVE',
    },
  })
  return { id: account.id, phone: account.phone }
}

interface CreateTenantOpts {
  status: 'ACTIVE' | 'TRIAL' | 'DEREGISTERED'
  planExpireAt?: Date | null
  trialEndAt?: Date | null
  deregisterAt?: Date | null
  retentionDays?: number
  withPlan?: boolean
}

/** 直接建一个 `Tenant`（不经 `/api/platform/tenants`），见文件头为什么这么选。 */
async function createTenant(
  index: number,
  opts: CreateTenantOpts,
): Promise<{ id: string; ownerAccountId: string; ownerPhone: string }> {
  const owner = await createOwnerAccount()
  const tenant = await prisma.tenant.create({
    data: {
      id: ulid(),
      slug: `e2e-lc-${index}-${RUN}`,
      name: `E2E 生命周期 ${index} ${RUN}`,
      status: opts.status,
      planId: opts.withPlan === false ? null : planId,
      planExpireAt: opts.planExpireAt ?? null,
      trialEndAt: opts.trialEndAt ?? null,
      graceDays: 0,
      retentionDays: opts.retentionDays ?? 7,
      deregisterAt: opts.deregisterAt ?? null,
      ownerAccountId: owner.id,
    },
  })
  return { id: tenant.id, ownerAccountId: owner.id, ownerPhone: owner.phone }
}

/** 距今 `days` 个日历日（按 Asia/Shanghai）当天最后一刻——与 `evaluateTenantGate` 同一套时区口径。 */
function expireAtDaysFromNow(days: number, from: Date = new Date()): Date {
  return endOfCalendarDay(addCalendarDays(calendarDayOf(from), days))
}

/**
 * 「手动触发」一次 cron 方法。
 *
 * 真实入口 `CronScheduler.runTick` 会先 `runInFreshContext` 开一个新上下文（cron tick
 * 没有上游请求）再调用 `@LeaderCron` 方法——`ExpireNotifyCron`/`TrialConvertCron` 内部
 * 用的 `runWithPatchedContext({ tenantId })`（发通知、写审计要用）依赖的正是「已经在
 * 某个上下文里」这个前提。直接 `await cron.run()` 会跳过这一层，表现为
 * `MissingRequestContextError`——这是测试没有还原生产环境下 cron 方法实际执行时的样子，
 * 不是被测代码的 bug，所以在测试里补上这一层，而不是去改 `runWithPatchedContext` 的契约。
 */
function triggerCron<T>(fn: () => Promise<T>): Promise<T> {
  return runInFreshContext({}, () => fn())
}

/** 轮询等一个条件（通知是旁路写入，方法返回时不保证已经落库完毕）。 */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

beforeAll(async () => {
  prisma = new PrismaClient()
  ownerPasswordHash = await hashPassword(OWNER_PASSWORD)
  await seedBase(
    {
      platformAdmin: prisma.platformAdmin,
      plan: prisma.plan,
      tenant: prisma.tenant,
      staffAccount: prisma.staffAccount,
      staff: findFirstUpsertDelegate(prisma.staff),
      role: findFirstUpsertDelegate(prisma.role),
      rolePreset: prisma.rolePreset,
    },
    { withDemoTenant: false },
  )

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  configureApp(app)
  await app.init()

  planOrders = app.get(PlanOrderService)
  expireNotify = app.get(ExpireNotifyCron)
  trialConvert = app.get(TrialConvertCron)

  const plan = await prisma.plan.create({
    data: {
      id: ulid(),
      code: `e2e-lc-plan-${RUN}`,
      name: `E2E 生命周期套餐 ${RUN}`,
      firstPriceCents: FIRST_PRICE_CENTS,
      renewPriceCents: RENEW_PRICE_CENTS,
      periodMonths: PERIOD_MONTHS,
      quotas: {},
      appKeys: ['admin', 'client'],
      trafficMb: 0,
      status: 'ENABLED',
    },
  })
  planId = plan.id
})

afterAll(async () => {
  await app?.close()
  await prisma?.$disconnect()
})

// ─────────────────────────────────────────────────────────────────────────────
// ①③ 到期提醒：命中档位、当天幂等、续费后不再提醒
// ─────────────────────────────────────────────────────────────────────────────

describe('①③ 到期提醒：T-3 命中 → 幂等 → 续费后不再提醒', () => {
  let tenantId = ''
  let ownerAccountId = ''
  let ownerPhone = ''
  const stageKey = planExpireInboxKey('-3')
  const stageSmsKey = planExpireSmsKey('-3')

  beforeAll(async () => {
    const t = await createTenant(1, { status: 'ACTIVE', planExpireAt: expireAtDaysFromNow(3) })
    tenantId = t.id
    ownerAccountId = t.ownerAccountId
    ownerPhone = t.ownerPhone
  })

  it('① 手动触发一次：店主收到一条 INBOX（NotifyRecord.channel===IN_APP）与一条 SMS', async () => {
    await triggerCron(() => expireNotify.run())

    await waitFor(
      async () =>
        (await prisma.notifyRecord.count({ where: { tenantId, templateKey: stageKey } })) === 1,
    )
    const inbox = await prisma.notifyRecord.findFirstOrThrow({
      where: { tenantId, templateKey: stageKey },
    })
    expect(inbox.channel).toBe('IN_APP')
    expect(inbox.status).toBe('SENT')
    expect(inbox.to).toBe(ownerAccountId)

    const sms = await prisma.notifyRecord.findFirstOrThrow({
      where: { tenantId, templateKey: stageSmsKey },
    })
    expect(sms.channel).toBe('SMS')
    expect(sms.to).toBe(ownerPhone)
  })

  it('① 再触发一次：不重复（同一天同一档位幂等命中）', async () => {
    await triggerCron(() => expireNotify.run())
    // 幂等：不会新增第二条。给旁路写入留够时间后再断言数量没有变化。
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await prisma.notifyRecord.count({ where: { tenantId, templateKey: stageKey } })).toBe(1)
    expect(await prisma.notifyRecord.count({ where: { tenantId, templateKey: stageSmsKey } })).toBe(
      1,
    )
  })

  it('③ 走 PlanOrderService 续费之后，daysLeft 不再落在任何档位上 → 再触发不产生新提醒', async () => {
    const order = await planOrders.create({
      tenantId,
      planId,
      periods: 12,
      channel: 'OFFLINE',
      operatorId: 'e2e-operator',
    })
    const result = await planOrders.markPaidOffline(order.id, 'e2e-operator')
    expect(result.fresh).toBe(true)
    // 12 个月之后，daysLeft 远大于 7，五档一个都不命中。
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    expect(tenant.status).toBe('ACTIVE')
    expect(tenant.planExpireAt!.getTime()).toBeGreaterThan(Date.now() + 300 * 24 * 60 * 60 * 1000)

    const beforeInbox = await prisma.notifyRecord.count({
      where: { tenantId, templateKey: stageKey },
    })
    const beforeSms = await prisma.notifyRecord.count({
      where: { tenantId, templateKey: stageSmsKey },
    })

    // 不断言全局 outcome.matched===0：这一轮会扫到全库所有 ACTIVE/TRIAL 租户（含别的
    // describe 块、甚至历史跑遗留的租户），全局命中数不为 0 是正常的——真正要证明的是
    // 「这一家续费过的租户」不再命中，所以直接查它自己的 NotifyRecord 计数有没有变化。
    await triggerCron(() => expireNotify.run())

    expect(await prisma.notifyRecord.count({ where: { tenantId, templateKey: stageKey } })).toBe(
      beforeInbox,
    )
    expect(await prisma.notifyRecord.count({ where: { tenantId, templateKey: stageSmsKey } })).toBe(
      beforeSms,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 三个 app 实例同时触发同一个 tick
// ─────────────────────────────────────────────────────────────────────────────

describe('② 3 个实例同时触发：CronRun 同一 key 只一条、通知只一条', () => {
  let tenantId = ''
  const stageKey = planExpireInboxKey('-1')

  beforeAll(async () => {
    const t = await createTenant(2, { status: 'ACTIVE', planExpireAt: expireAtDaysFromNow(1) })
    tenantId = t.id
  })

  it('3 个独立的 Nest app 实例并发 runTick：只有一个真正执行', async () => {
    const apps: INestApplication[] = []
    try {
      for (let i = 0; i < 3; i += 1) {
        const ref = await Test.createTestingModule({ imports: [AppModule] }).compile()
        const one = ref.createNestApplication({ logger: false })
        configureApp(one)
        await one.init()
        apps.push(one)
      }

      const defsOf = (
        a: INestApplication,
      ): { scheduler: CronScheduler; def: LeaderCronDefinition } => {
        const scheduler = a.get(CronScheduler)
        const def = a
          .get(CronRegistry)
          .discover()
          .find((d) => d.key === 'plan-expire-notify')
        expect(def, 'plan-expire-notify 这个 @LeaderCron 必须被扫描到').toBeDefined()
        return { scheduler, def: def! }
      }

      const tickStartedAt = new Date()
      const outcomes = await Promise.all(
        apps.map((a) => {
          const { scheduler, def } = defsOf(a)
          return scheduler.runTick(def)
        }),
      )

      expect(outcomes.filter((o) => o.leader)).toHaveLength(1)
      expect(outcomes.filter((o) => !o.leader)).toHaveLength(2)

      // 只看这次 tick 起之后的 CronRun 行，历史文件跑过的旧记录不该混进来。
      const cronRuns = await prisma.cronRun.findMany({
        where: { key: 'plan-expire-notify', startedAt: { gte: tickStartedAt } },
      })
      expect(cronRuns).toHaveLength(1)
      expect(cronRuns[0]?.ok).toBe(true)

      await waitFor(
        async () =>
          (await prisma.notifyRecord.count({ where: { tenantId, templateKey: stageKey } })) === 1,
      )
      expect(await prisma.notifyRecord.count({ where: { tenantId, templateKey: stageKey } })).toBe(
        1,
      )
    } finally {
      await Promise.all(apps.map((a) => a.close()))
    }
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ 到期后 3 天命中 +3 档位
// ─────────────────────────────────────────────────────────────────────────────

describe('④ 到期后 3 天（daysLeft=-3）命中 +3 档位', () => {
  it('店主收到 plan.expire.+3 的 INBOX', async () => {
    const t = await createTenant(4, { status: 'ACTIVE', planExpireAt: expireAtDaysFromNow(-3) })
    const stageKey = planExpireInboxKey('+3')

    const outcome = await triggerCron(() => expireNotify.run())
    expect(outcome.matched).toBeGreaterThanOrEqual(1)

    await waitFor(
      async () =>
        (await prisma.notifyRecord.count({ where: { tenantId: t.id, templateKey: stageKey } })) ===
        1,
    )
    const record = await prisma.notifyRecord.findFirstOrThrow({
      where: { tenantId: t.id, templateKey: stageKey },
    })
    expect(record.channel).toBe('IN_APP')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ retention --dry-run：只列名单，不动库
// ─────────────────────────────────────────────────────────────────────────────

describe('⑤ retention：列出超期的 DEREGISTERED 租户，但不删任何数据', () => {
  it('deregisterAt + retentionDays 已过的租户出现在名单里，Tenant 行数不变', async () => {
    const deregisterAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 天前注销
    const t = await createTenant(5, {
      status: 'DEREGISTERED',
      deregisterAt,
      retentionDays: 7, // 早就超过 7 天保留期
      withPlan: false,
    })
    const stillFresh = await createTenant(6, {
      status: 'DEREGISTERED',
      deregisterAt: new Date(), // 刚注销，还在保留期内
      retentionDays: 30,
      withPlan: false,
    })

    const beforeCount = await prisma.tenant.count()
    const overdue = await listOverdueTenants(prisma)
    const afterCount = await prisma.tenant.count()

    expect(afterCount).toBe(beforeCount)
    expect(overdue.some((r) => r.id === t.id)).toBe(true)
    expect(overdue.some((r) => r.id === stillFresh.id)).toBe(false)

    // 库里这两行原样还在——`listOverdueTenants` 真的只读。
    expect(await prisma.tenant.findUnique({ where: { id: t.id } })).not.toBeNull()
    expect(await prisma.tenant.findUnique({ where: { id: stillFresh.id } })).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ trial-convert：默认不转化；配了 SIGNUP_TRIAL_AUTO_PLAN 时自动转化
// ─────────────────────────────────────────────────────────────────────────────

describe('⑥ trial-convert：默认保持 TRIAL 不动，配置了免费套餐时走统一 fulfill 路径自动转化', () => {
  it('默认（SIGNUP_TRIAL_AUTO_PLAN 未配）：试用到期租户保持 TRIAL，不产生任何 PlanOrder', async () => {
    const t = await createTenant(7, {
      status: 'TRIAL',
      trialEndAt: expireAtDaysFromNow(-1),
      withPlan: false,
    })

    const outcome = await triggerCron(() => trialConvert.run())
    expect(outcome.autoPlanConfigured).toBe(false)
    expect(outcome.scanned).toBe(0)

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })
    expect(tenant.status).toBe('TRIAL')
    expect(tenant.planId).toBeNull()
    expect(await prisma.planOrder.count({ where: { tenantId: t.id } })).toBe(0)
  })

  it('配了 SIGNUP_TRIAL_AUTO_PLAN（免费套餐）：走 PlanOrderService 自动转化为 ACTIVE', async () => {
    const freePlan = await prisma.plan.create({
      data: {
        id: ulid(),
        code: `e2e-lc-free-${RUN}`,
        name: `E2E 自动转化免费套餐 ${RUN}`,
        firstPriceCents: 0,
        renewPriceCents: 0,
        periodMonths: 1,
        quotas: {},
        appKeys: ['admin', 'client'],
        trafficMb: 0,
        status: 'ENABLED',
      },
    })

    const t = await createTenant(8, {
      status: 'TRIAL',
      trialEndAt: expireAtDaysFromNow(-1),
      withPlan: false,
    })

    // 覆盖 ENV：只有这一个字段不同，其余原样来自 process.env（与主 app 一致）。
    const overriddenEnv = APP_ENV_SCHEMA.parse({
      ...process.env,
      SIGNUP_TRIAL_AUTO_PLAN: freePlan.code,
    })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue(overriddenEnv)
      .compile()
    const autoApp = moduleRef.createNestApplication({ logger: false })
    configureApp(autoApp)
    await autoApp.init()

    try {
      const outcome = await triggerCron(() => autoApp.get(TrialConvertCron).run())
      expect(outcome.autoPlanConfigured).toBe(true)
      expect(outcome.converted).toBeGreaterThanOrEqual(1)
      expect(outcome.errors).toBe(0)

      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })
      expect(tenant.status).toBe('ACTIVE')
      expect(tenant.planId).toBe(freePlan.id)
      expect(tenant.planExpireAt).not.toBeNull()
      expect(tenant.planExpireAt!.getTime()).toBeGreaterThan(Date.now())

      const order = await prisma.planOrder.findFirstOrThrow({ where: { tenantId: t.id } })
      expect(order.status).toBe('FULFILLED')
      expect(order.amountCents).toBe(0)
      expect(order.payChannel).toBe('OFFLINE')
      expect(order.operatorId).toBe(AUTO_CONVERT_OPERATOR_ID)

      await waitFor(
        async () =>
          (await prisma.auditLog.count({
            where: { tenantId: t.id, action: 'plan-order.fulfill' },
          })) === 1,
      )
    } finally {
      await autoApp.close()
    }
  }, 20_000)

  it('免费套餐配错成收费套餐：跳过自动转化（防呆）', async () => {
    const notFreePlan = await prisma.plan.create({
      data: {
        id: ulid(),
        code: `e2e-lc-notfree-${RUN}`,
        name: `E2E 配错的收费套餐 ${RUN}`,
        firstPriceCents: 1000,
        renewPriceCents: 500,
        periodMonths: 1,
        quotas: {},
        appKeys: ['admin', 'client'],
        trafficMb: 0,
        status: 'ENABLED',
      },
    })
    const t = await createTenant(9, {
      status: 'TRIAL',
      trialEndAt: expireAtDaysFromNow(-1),
      withPlan: false,
    })

    const overriddenEnv = APP_ENV_SCHEMA.parse({
      ...process.env,
      SIGNUP_TRIAL_AUTO_PLAN: notFreePlan.code,
    })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue(overriddenEnv)
      .compile()
    const guardApp = moduleRef.createNestApplication({ logger: false })
    configureApp(guardApp)
    await guardApp.init()

    try {
      const outcome = await triggerCron(() => guardApp.get(TrialConvertCron).run())
      expect(outcome.autoPlanConfigured).toBe(true)
      expect(outcome.scanned).toBe(0)
      expect(outcome.converted).toBe(0)

      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t.id } })
      expect(tenant.status).toBe('TRIAL')
      expect(tenant.planId).toBeNull()
    } finally {
      await guardApp.close()
    }
  }, 20_000)
})
