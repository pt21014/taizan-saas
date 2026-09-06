/**
 * 套餐订单的**唯一**写路径（T1-5，蓝图 §4.6）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## 这个文件存在的全部理由：`fulfill()` 只能有一个
 *
 * 「把钱变成权益」这件事有三个入口——在线支付回调、平台后台线下标记已付、
 * 平台后台续期——它们**必须调同一个函数**。分开写的下场在 xiaodian 见过：
 * 回调那条记得清 `PlatformGateway` 缓存、线下那条忘了，于是运营手工核销之后
 * 商家的后台还锁着，运营再点一次、订单被兑现两次，到期日凭空多了一年。
 *
 * 收口是靠 `test/arch/plan-order-fulfill.spec.ts` 扫源码盯着的：
 * `Tenant.planExpireAt` 的写入与 `PlanOrder.status: 'FULFILLED'` 的写入
 * 在整个 `src/**` 里**只允许出现在本文件**。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## 事务边界与审计落在哪张表
 *
 * 事务只包「钱 → 权益」这一段：`PlanOrder` 置 `PAID → FULFILLED` + `Tenant` 延期。
 * 两张表必须原子，中间崩了就是「商家付了钱、订单显示已兑现、后台还锁着」。
 *
 * 事务走 **`raw` 句柄**，这是被逼的、也是对的：`Tenant` 是**平台域**表，没有
 * `tenantId` 列、没有登记进 `TENANT_MODELS`，而本应用把 `onUnregistered` 设成了
 * `'throw'`——用 `prisma.tenant` 开的事务碰到 `tx.tenant.update()` 会当场抛
 * `MODEL_NOT_REGISTERED`。所以「同一个事务里既写租户域表又写平台域表」在本架构下
 * 只有 raw 一条路。
 *
 * 代价是**审计记录进不了这个事务**：`AuditService.record()` 写的租户域 `AuditLog`
 * 需要隔离扩展从上下文注入 `tenantId`，而 raw 事务客户端身上没有那个扩展，硬塞
 * `tx` 进去只会得到一句「Argument tenantId is missing」。所以审计在**事务提交之后**
 * 写，和站内信、`gateway.invalidate()` 一起，全部包在 `runWithPatchedContext`
 * （回调进来时没有租户上下文，`prisma.tenant` 与 `NotifyRecord` 都要靠它）里。
 * 审计写失败不吞：打 error + `HealthCounters.auditFailures` +1（蓝图 §4.8），
 * 但不回滚——钱已经变成权益了，为了一条日志把商家的套餐退回去是本末倒置。
 *
 * ## 幂等是双保险
 *
 * 渠道回调那一层由 `@taizan/nest-payment` 用 `transactionId` 挡（`IdempotencyService`）。
 * 但那只挡得住「同一次回调被推了多次」；挡不住「同一笔单被不同来源兑现两次」
 * （回调 + 运营手工核销 + 主动查单补偿）。所以 `fulfill()` 自己**先读状态**：
 * 已经是 `FULFILLED` 的直接原样返回，不抛错也不重复延期。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, Optional } from '@nestjs/common'
import { computeRefundRollback } from '@taizan/billing-rules'
import { ErrorCode, normalizePage, ulid, type PageResult } from '@taizan/contracts'
import { AUDIT_ACTIONS, AuditService } from '@taizan/nest-audit'
import { PLATFORM_GATEWAY, type PlatformGateway } from '@taizan/nest-billing'
import { AppLogger, BizException, HealthCounters, runWithPatchedContext } from '@taizan/nest-core'
import { LeaderCron } from '@taizan/nest-infra'
import { NotifyService } from '@taizan/nest-notify'
import { PaymentService } from '@taizan/nest-payment'
import { RawPrismaService } from '@taizan/nest-prisma'
import { buildOutTradeNo, PLAN_ORDER_PREFIX, type PayChannel } from '@taizan/payment-core'
import { NOTIFY_TEMPLATE_KEYS } from '@taizan/prisma-base'

import type { AppPrismaClient } from '../../../common/prisma.types'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  assertTransition,
  computeFulfillPeriod,
  computeOrderAmount,
  nextTenantStatus,
  resolveOrderType,
  timeoutCutoff,
  type PlanOrderStatus,
} from './plan-order.rules'

const CONTEXT = 'PlanOrderService'

/**
 * 交互式事务里拿到的客户端。
 *
 * 不能直接用 `AppPrismaClient`：Prisma 的 `$transaction(fn)` 传进来的是
 * `Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>`
 * ——少了那五个方法**是故意的**（在一个事务里再开一个事务、或者中途断连，
 * 都是能把连接池吃干净的写法）。类型上照抄这个 Omit，调用方就不会试图那么干。
 */
export type PlanOrderTx = Omit<
  AppPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>

/**
 * 站内信模板 key。
 *
 * 真源是 `@taizan/prisma-base` 的 `NOTIFY_TEMPLATE_KEYS.PLAN_FULFILLED`
 * （`'plan.fulfilled'`）——`src/registry/notify-templates.ts` 的内存模板也从那份
 * 常量转换而来，两处不会各拼一份 key 字符串。
 */
export const PLAN_ORDER_FULFILLED_TEMPLATE = NOTIFY_TEMPLATE_KEYS.PLAN_FULFILLED

/** 一行 `PlanOrder`。 */
export type PlanOrderRow = NonNullable<
  Awaited<ReturnType<AppPrismaClient['planOrder']['findUnique']>>
>

/** 一行 `Plan`。 */
export type PlanRow = NonNullable<Awaited<ReturnType<AppPrismaClient['plan']['findUnique']>>>

/** 下单入参。 */
export interface CreatePlanOrderInput {
  tenantId: string
  planId: string
  /** 买几个计费周期。 */
  periods: number
  /** 收款渠道。`OFFLINE` = 线下打款，由运营手工核销。 */
  channel: PayChannel
  /** 平台运营代下单时的操作人（`PlatformAdmin.id`）；商家自助下单为空。 */
  operatorId?: string
}

/** 兑现入参。 */
export interface FulfillPlanOrderInput {
  /** 渠道流水号；线下核销没有。 */
  transactionId?: string
  paidAt: Date
  /** 这次兑现是谁触发的。**只影响留痕，不影响任何一行落库逻辑**。 */
  via: 'CALLBACK' | 'OFFLINE'
  /** 线下核销的操作人（`PlatformAdmin.id`）。 */
  operatorId?: string
}

/** 兑现产出。 */
export interface FulfillPlanOrderResult {
  order: PlanOrderRow
  /** 这一次是不是真的兑现了；`false` = 订单早就是 FULFILLED，幂等命中。 */
  fresh: boolean
  expireBeforeAt: Date | null
  expireAfterAt: Date
}

/** 退款产出。 */
export interface RefundPlanOrderResult {
  order: PlanOrderRow
  /**
   * 到期日**有没有真的回退**。
   *
   * `false` 时订单状态也不动——见 `computeRefundRollback` 的 `SUPERSEDED`：
   * 这张单之后又续过费，按月加出来的那一段没法可靠地减回去
   * （`1/31 +1月 = 2/28`，减 1 个月只能回到 `1/28`，平白吃掉商家 3 天），
   * 所以交人工核对，比悄悄算错一个没人会发现的到期日要好。
   */
  applied: boolean
  reason?: 'ALREADY_ROLLED_BACK' | 'SUPERSEDED'
  expireAt: Date | null
}

@Injectable()
export class PlanOrderService {
  constructor(
    // raw-reason: 平台收费闭环——`Tenant` / `Plan` 是平台域表（没有 tenantId 列），
    // 支付回调进来时又完全没有租户上下文（租户是按 outTradeNo 反查出来的）。
    // 这两件事都不可能用 prisma.tenant 做，见文件头「事务边界」那一段。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional() @Inject(PLATFORM_GATEWAY) private readonly gateway?: PlatformGateway,
    @Optional() @Inject(NotifyService) private readonly notify?: NotifyService,
    @Optional() @Inject(PaymentService) private readonly payment?: PaymentService,
    @Optional() @Inject(HealthCounters) private readonly counters?: HealthCounters,
  ) {}

  // ── 下单 ────────────────────────────────────────────────────────────────

  /**
   * 落一张 `PENDING` 订单。**不碰租户的任何一个字段**——下单不等于付款。
   *
   * `outTradeNo` 用 `buildOutTradeNo(PLAN_ORDER_PREFIX)` 生成（`PLAN-<ULID>`）：
   * 前缀就是领域标识，统一回调控制器只按它把回调分发给
   * `PlanOrderPaymentHandler`。自己拼一个不带前缀的单号，回调进来会找不到处理器——
   * 表现是「钱到账、没人兑现、日志里一条 error」。
   *
   * @throws `BizException` 1040000：租户/套餐不存在、套餐已归档、租户已注销
   */
  async create(input: CreatePlanOrderInput): Promise<PlanOrderRow> {
    const tenant = await this.requireTenant(input.tenantId)
    if (tenant.status === 'DEREGISTERED') {
      throw new BizException(ErrorCode.BAD_REQUEST, '已注销的店不能下单')
    }
    const plan = await this.requirePlan(input.planId)
    if (plan.status === 'ARCHIVED') {
      throw new BizException(ErrorCode.BAD_REQUEST, '该套餐已归档，不再售卖')
    }

    const hasFulfilledBefore = await this.hasFulfilledBefore(input.tenantId)
    const amountCents = computeOrderAmount({
      firstPriceCents: plan.firstPriceCents,
      renewPriceCents: plan.renewPriceCents,
      periods: input.periods,
      hasFulfilledBefore,
    })

    // raw-reason: 平台收费闭环——`PlanOrder` 虽是租户域表，但下单的三个入口里有两个
    // （运营代下单、支付回调补单）根本没有租户上下文，统一走 raw 并显式写 tenantId。
    const order = await this.raw.client.planOrder.create({
      data: {
        id: ulid(),
        tenantId: input.tenantId,
        planId: plan.id,
        type: resolveOrderType({
          hasFulfilledBefore,
          currentPlanId: tenant.planId,
          targetPlanId: plan.id,
        }),
        periods: input.periods,
        amountCents,
        discountCents: 0,
        status: 'PENDING',
        payChannel: input.channel,
        outTradeNo: buildOutTradeNo(PLAN_ORDER_PREFIX),
        ...(input.operatorId ? { operatorId: input.operatorId } : {}),
      },
    })
    this.logger.log(
      `套餐订单 ${order.outTradeNo} 已创建：租户 ${input.tenantId}、套餐 ${plan.code}、` +
        `${input.periods} 期、${amountCents} 分、渠道 ${input.channel}`,
      CONTEXT,
    )
    return order
  }

  // ── 兑现：唯一路径 ──────────────────────────────────────────────────────

  /**
   * **把钱变成权益。三个入口共用的唯一实现。**
   *
   * 同一个事务里做两件事，一件都不能少：
   * 1. `PlanOrder`：`PENDING → PAID → FULFILLED`（两步都落，好让「收了钱没发货」
   *    在事故现场是个可查询的状态，而不是靠猜）；
   * 2. `Tenant`：`planId` / `planExpireAt`（`max(原到期, now) + periods×periodMonths`
   *    当天末）+ `TRIAL → ACTIVE`。
   *
   * 提交之后才做副作用（缓存失效 / 审计 / 站内信）——它们失败不该把已经生效的权益
   * 回滚掉，理由见文件头。
   *
   * @param orderId - `PlanOrder.id`
   * @param input - 见 {@link FulfillPlanOrderInput}
   * @param tx - 调用方已经开着的事务；不传就自己开一个。留这个口子是因为将来
   *   「下单即兑现」（0 元套餐、赠送）会想把它和别的写操作放进同一个事务
   * @throws `BizException` 1040000：订单不存在、状态机不允许
   */
  async fulfill(
    orderId: string,
    input: FulfillPlanOrderInput,
    tx?: PlanOrderTx,
  ): Promise<FulfillPlanOrderResult> {
    const existing = await this.requireOrder(orderId)

    // 双保险的第二道：控制器那层用 transactionId 挡「同一次回调推了多次」，
    // 这一层挡「同一笔单被不同来源兑现两次」。**返回而不是抛**——对调用方来说
    // 「已经兑现过了」是成功，抛错只会让渠道以为我们没收到、继续重推一整天。
    if (existing.status === 'FULFILLED') {
      this.logger.warn(
        `套餐订单 ${existing.outTradeNo} 已经是 FULFILLED，本次 ${input.via} 兑现按幂等命中跳过`,
        CONTEXT,
      )
      return {
        order: existing,
        fresh: false,
        expireBeforeAt: existing.expireBeforeAt,
        expireAfterAt: existing.expireAfterAt ?? new Date(0),
      }
    }
    assertTransition(existing.status as PlanOrderStatus, 'PAID')

    const plan = await this.requirePlan(existing.planId)
    const tenant = await this.requireTenant(existing.tenantId)
    const now = new Date()
    const { expireBeforeAt, expireAfterAt } = computeFulfillPeriod({
      currentExpireAt: tenant.planExpireAt,
      now,
      periods: existing.periods,
      periodMonths: plan.periodMonths,
    })
    const status = nextTenantStatus(tenant.status)

    const run = async (client: PlanOrderTx): Promise<PlanOrderRow> => {
      // 先 PAID 再 FULFILLED：状态机上这是两条边，落库上是同一个事务里的两次 update。
      // 合成一次 `PENDING → FULFILLED` 会让状态机表里那条 `PAID → FULFILLED` 变成死边。
      await client.planOrder.update({
        where: { id: orderId },
        data: {
          status: 'PAID',
          paidAt: input.paidAt,
          ...(input.transactionId ? { transactionId: input.transactionId } : {}),
          ...(input.operatorId ? { operatorId: input.operatorId } : {}),
        },
      })
      assertTransition('PAID', 'FULFILLED')
      const fulfilled = await client.planOrder.update({
        where: { id: orderId },
        data: { status: 'FULFILLED', fulfilledAt: now, expireBeforeAt, expireAfterAt },
      })
      await client.tenant.update({
        where: { id: existing.tenantId },
        data: {
          planId: plan.id,
          planExpireAt: expireAfterAt,
          ...(status ? { status } : {}),
        },
      })
      return fulfilled
    }

    // raw-reason: 平台收费闭环——一个事务里同时写租户域的 PlanOrder 与平台域的 Tenant，
    // 只有 raw 句柄做得到（见文件头）。tenantId 由订单行本身给出，不来自上下文。
    const order = tx ? await run(tx) : await this.raw.client.$transaction(run)

    await this.afterFulfill(order, plan, expireAfterAt, input)
    return { order, fresh: true, expireBeforeAt, expireAfterAt }
  }

  /**
   * 平台后台「标记已付」。
   *
   * 它就是 `fulfill(..., via: 'OFFLINE')` 的一层薄包装，**一行落库逻辑都不重写**——
   * 蓝图 §4.6 点名的那条：「`OFFLINE` 通道走同一个事务，不许另写一遍」。
   */
  async markPaidOffline(orderId: string, operatorId: string): Promise<FulfillPlanOrderResult> {
    return this.fulfill(orderId, { paidAt: new Date(), via: 'OFFLINE', operatorId })
  }

  // ── 退款 ────────────────────────────────────────────────────────────────

  /**
   * 退款：先把钱退回去，再把到期日回退到这张单履约前的 `expireBeforeAt`。
   *
   * 顺序不能反。先改到期日再调渠道的话，渠道那一步失败（余额不足、单号对不上）
   * 就变成「商家的套餐被收回了，钱一分没退」——那是最难解释的一种事故。
   *
   * `SUPERSEDED`（这之后又续过费）时**什么都不做**并回 `applied: false`，
   * 交平台人工核对，理由见 {@link RefundPlanOrderResult.applied}。
   *
   * @throws `BizException` 1040000：订单不存在、不是 FULFILLED
   */
  async refund(
    orderId: string,
    operatorId: string,
    reason: string,
  ): Promise<RefundPlanOrderResult> {
    const order = await this.requireOrder(orderId)
    assertTransition(order.status as PlanOrderStatus, 'REFUNDED')
    const tenant = await this.requireTenant(order.tenantId)

    const rollback = computeRefundRollback({
      currentExpireAt: tenant.planExpireAt,
      expireBeforeAt: order.expireBeforeAt,
      expireAfterAt: order.expireAfterAt,
    })
    if (!rollback.applied) {
      this.logger.warn(
        `套餐订单 ${order.outTradeNo} 退款未自动回退到期日（${rollback.reason}），已交人工处理`,
        CONTEXT,
      )
      return {
        order,
        applied: false,
        ...(rollback.reason ? { reason: rollback.reason } : {}),
        expireAt: rollback.expireAt,
      }
    }

    // 线下打款的原路退回是运营在银行那边做的，系统这边只负责留痕与回退权益。
    if (order.payChannel !== null && order.payChannel !== 'OFFLINE' && order.amountCents > 0) {
      if (!this.payment) {
        throw new BizException(ErrorCode.BAD_REQUEST, '未装配支付渠道，无法发起线上退款')
      }
      await this.payment.refund({
        channel: order.payChannel,
        outTradeNo: order.outTradeNo,
        paidCents: order.amountCents,
        refundCents: order.amountCents,
        // 退款单号由订单 id 派生而不是随机生成：重试必须复用同一个单号，
        // 换一个就是发起第二笔退款——**会退两次钱**。
        outRefundNo: buildOutTradeNo('RFD', order.id),
        reason,
      })
    }

    // raw-reason: 平台收费闭环——退款同样要在一个事务里写租户域订单 + 平台域租户。
    const updated = await this.raw.client.$transaction(async (client) => {
      const row = await client.planOrder.update({
        where: { id: orderId },
        data: { status: 'REFUNDED', operatorId },
      })
      await client.tenant.update({
        where: { id: order.tenantId },
        data: { planExpireAt: rollback.expireAt },
      })
      return row
    })

    this.gateway?.invalidate(order.tenantId)
    await this.recordTenantAudit(order.tenantId, {
      action: AUDIT_ACTIONS.PLAN_ORDER_REFUND,
      actorType: 'PLATFORM_ADMIN',
      actorId: operatorId,
      actorName: '平台运营',
      targetType: 'PlanOrder',
      targetId: order.id,
      before: { status: order.status, planExpireAt: tenant.planExpireAt?.toISOString() ?? null },
      after: {
        status: 'REFUNDED',
        planExpireAt: rollback.expireAt?.toISOString() ?? null,
        refundCents: order.amountCents,
        reason,
      },
    })
    return { order: updated, applied: true, expireAt: rollback.expireAt }
  }

  // ── 超时取消 ────────────────────────────────────────────────────────────

  /**
   * 把超过 30 分钟还没付的 `PENDING` 单批量置 `CANCELLED`。
   *
   * `@LeaderCron` 而不是 `setInterval`：pm2 cluster 起 4 个进程时，裸定时器会让
   * 同一批单被取消 4 次（这次只是浪费几条 update，但同一个模式在「关单 + 原路退款」
   * 上就是真的多退了三次钱——knowledge 那条线上活故障）。leader 锁保证一个 tick
   * 只有一台实例真的跑。
   *
   * 一条 `updateMany` 而不是「先 findMany 再逐行更新」：积压几万张废单时后者会把
   * 内存吃光，而且中途失败会留下取消了一半的状态。
   *
   * @returns 本轮取消了几张
   */
  @LeaderCron({
    key: 'plan-order-cancel-expired',
    cron: '*/5 * * * *',
    lockTtlMs: 120_000,
    timezone: 'Asia/Shanghai',
  })
  async cancelExpired(now: Date = new Date()): Promise<number> {
    // raw-reason: 平台收费闭环——cron 没有租户上下文，这是一次跨租户的批量关单。
    const res = await this.raw.client.planOrder.updateMany({
      where: { status: 'PENDING', createdAt: { lt: timeoutCutoff(now) } },
      data: { status: 'CANCELLED' },
    })
    if (res.count > 0) {
      this.logger.log(`超时取消了 ${res.count} 张未支付的套餐订单（30 分钟未付）`, CONTEXT)
    }
    return res.count
  }

  // ── 查询（商家侧账单与可购套餐都借道这里） ──────────────────────────────

  /**
   * 在售套餐。
   *
   * 放在本服务而不是 `AdminBillingService` 里，是因为 `Plan` 是**平台域**表：
   * 它没登记进 `TENANT_MODELS`，而本应用的 `onUnregistered` 是 `'throw'`——
   * 商家侧用 `prisma.tenant.plan` 读它会当场抛 `MODEL_NOT_REGISTERED`。
   * 读平台域表的代码就该待在 raw 白名单覆盖的 `src/modules/platform/` 里。
   */
  async listPurchasablePlans(): Promise<PlanRow[]> {
    // raw-reason: 平台域表 Plan（无 tenantId 列），全平台共享一份，租户只读。
    return this.raw.client.plan.findMany({
      where: { status: 'ENABLED' },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    })
  }

  /** 某个租户自己的账单分页。 */
  async listByTenant(
    tenantId: string,
    query: { page?: number; pageSize?: number },
  ): Promise<PageResult<PlanOrderRow>> {
    const { page, pageSize } = normalizePage(query)
    // raw-reason: 平台收费闭环——与本服务其它读写共用 raw 句柄；tenantId 是显式入参
    // （商家侧调用方从 token 里取，不是这里自己猜的）。
    const [items, total] = await Promise.all([
      this.raw.client.planOrder.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.raw.client.planOrder.count({ where: { tenantId } }),
    ])
    return { items, total, page, pageSize }
  }

  /** 取一张订单并校验它属于这家店（商家侧按 id 操作时用）。 */
  async getOwned(orderId: string, tenantId: string): Promise<PlanOrderRow> {
    const order = await this.requireOrder(orderId)
    if (order.tenantId !== tenantId) {
      throw new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN, '这张订单不属于当前店铺')
    }
    return order
  }

  /** 按商户单号取订单（支付回调用）。 */
  async findByOutTradeNo(outTradeNo: string): Promise<PlanOrderRow | null> {
    // raw-reason: 支付回调按参数定位租户（蓝图 §8 第 3 条）。回调进来时没有任何 token，
    // outTradeNo 是全局唯一的、也是唯一能反查出「这是哪家店的单」的线索。
    return this.raw.client.planOrder.findUnique({ where: { outTradeNo } })
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 兑现之后的副作用。**顺序是有讲究的**：先清缓存，再留痕，最后发通知。
   *
   * 清缓存排第一，因为它是唯一一个「不做就等于没续费」的动作——`PlatformGateway`
   * 的闸门视图有 30 秒进程内缓存，不失效的话商家付完钱后台还锁着，
   * 而他看到的是「已支付」四个字。审计与通知晚几十毫秒没人会察觉。
   */
  private async afterFulfill(
    order: PlanOrderRow,
    plan: PlanRow,
    expireAfterAt: Date,
    input: FulfillPlanOrderInput,
  ): Promise<void> {
    this.gateway?.invalidate(order.tenantId)

    await this.recordTenantAudit(order.tenantId, {
      action: APP_AUDIT_ACTIONS.PLAN_ORDER_FULFILL,
      actorType: input.via === 'OFFLINE' ? 'PLATFORM_ADMIN' : 'SYSTEM',
      actorId: input.operatorId ?? 'pay-callback',
      actorName: input.via === 'OFFLINE' ? '平台运营（线下核销）' : '支付回调',
      targetType: 'PlanOrder',
      targetId: order.id,
      after: {
        via: input.via,
        outTradeNo: order.outTradeNo,
        transactionId: order.transactionId,
        amountCents: order.amountCents,
        planCode: plan.code,
        periods: order.periods,
        expireBeforeAt: order.expireBeforeAt?.toISOString() ?? null,
        expireAfterAt: expireAfterAt.toISOString(),
      },
    })

    await this.sendFulfilledInbox(order, plan, expireAfterAt)
  }

  /**
   * 写一条**租户域** `AuditLog`——商家在自己的操作日志里要看得见「套餐续期了」。
   *
   * 为什么不传 `tx`：见文件头。为什么要 `runWithPatchedContext`：`AuditLog` 是租户域
   * 表，隔离扩展从上下文取 `tenantId`；支付回调那条路上下文里压根没有租户。
   *
   * 写失败**不吞**（蓝图 §4.8）：打 error + `auditFailures` +1，让 `/health` 看得见。
   * 但也不往外抛——钱已经变成权益了。
   */
  private async recordTenantAudit(
    tenantId: string,
    entry: Parameters<AuditService['record']>[0],
  ): Promise<void> {
    try {
      await runWithPatchedContext({ tenantId }, async () => {
        await this.audit.record(entry)
      })
    } catch (err) {
      this.counters?.increment('auditFailures')
      this.logger.error(
        `套餐订单审计写入失败（${entry.action} / ${String(entry.targetId)}）：${messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
    }
  }

  /**
   * 兑现成功的站内信。
   *
   * 失败只打 warn：通知是**尽力而为**的旁路，为了一条站内信把已经到账的套餐回滚掉
   * 是本末倒置。`NotifyService` 内部已经有失败进队列重试的机制，这里的 catch 兜的是
   * 「连入队都失败」那一层。
   */
  private async sendFulfilledInbox(
    order: PlanOrderRow,
    plan: PlanRow,
    expireAfterAt: Date,
  ): Promise<void> {
    if (!this.notify) return
    // raw-reason: 平台域表 Tenant——站内信要发给店主的登录账号（`ownerAccountId`）。
    const tenant = await this.raw.client.tenant.findUnique({ where: { id: order.tenantId } })
    try {
      await runWithPatchedContext({ tenantId: order.tenantId }, async () => {
        await this.notify?.send({
          tenantId: order.tenantId,
          templateKey: PLAN_ORDER_FULFILLED_TEMPLATE,
          to: { userId: tenant?.ownerAccountId ?? order.tenantId },
          channels: ['INBOX'],
          vars: {
            planName: plan.name,
            periods: String(order.periods),
            amountYuan: (order.amountCents / 100).toFixed(2),
            expireAt: expireAfterAt.toISOString().slice(0, 10),
          },
        })
      })
    } catch (err) {
      this.logger.warn(
        `套餐兑现站内信发送失败（订单 ${order.outTradeNo}）：${messageOf(err)}`,
        CONTEXT,
      )
    }
  }

  /** 有没有成功兑现过的历史订单——首购价与续费价的分界线。 */
  private async hasFulfilledBefore(tenantId: string): Promise<boolean> {
    // raw-reason: 平台收费闭环——运营代下单时没有租户上下文，tenantId 是显式入参。
    const count = await this.raw.client.planOrder.count({
      where: { tenantId, status: { in: ['FULFILLED', 'REFUNDED'] } },
    })
    return count > 0
  }

  private async requireOrder(orderId: string): Promise<PlanOrderRow> {
    // raw-reason: 平台收费闭环——按 id 取订单，回调与运营两条路都没有租户上下文。
    const row = await this.raw.client.planOrder.findUnique({ where: { id: orderId } })
    if (!row) throw new BizException(ErrorCode.BAD_REQUEST, '套餐订单不存在')
    return row
  }

  private async requirePlan(planId: string): Promise<PlanRow> {
    // raw-reason: 平台域表 Plan（无 tenantId 列）。
    const row = await this.raw.client.plan.findUnique({ where: { id: planId } })
    if (!row) throw new BizException(ErrorCode.BAD_REQUEST, '套餐不存在')
    return row
  }

  private async requireTenant(
    tenantId: string,
  ): Promise<NonNullable<Awaited<ReturnType<AppPrismaClient['tenant']['findUnique']>>>> {
    // raw-reason: 平台域表 Tenant（无 tenantId 列，它自己就是租户主体）。
    const row = await this.raw.client.tenant.findUnique({ where: { id: tenantId } })
    if (!row) throw new BizException(ErrorCode.TENANT_NOT_FOUND, '租户不存在')
    return row
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
