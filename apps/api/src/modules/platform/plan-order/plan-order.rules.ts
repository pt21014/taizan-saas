/**
 * 套餐订单状态机与金额计算的**纯函数**（蓝图 §4.6）。
 *
 * 这一层不碰数据库、不读时钟、不读进程时区——`now` 一律由调用方注入。理由和
 * `@taizan/billing-rules` 一样：状态机与钱的算法是「错了不会报错、只会在某天变成
 * 客诉」的那类代码，只有纯函数才能被穷举测试。执行层（事务、审计、通知、缓存失效）
 * 在 `plan-order.service.ts`。
 *
 * ## 状态机（蓝图 §4.6 那张图）
 *
 * ```
 *              平台后台开通 / 商家自助下单
 *                        │
 *                   [PENDING] ──超时 30min / 主动取消──> [CANCELLED]
 *                        │ 支付回调（验签→幂等→归一化）/ 线下标记已付
 *                        ▼
 *                     [PAID] ──同一事务──> [FULFILLED] ──平台后台退款──> [REFUNDED]
 * ```
 *
 * 三条边之外**一条都不许走**。尤其是 `CANCELLED → PAID`：超时取消跑完之后钱才到账
 * 是真实会发生的（用户在收银台停了 31 分钟才按确认），那时该做的是人工核销 + 原路退款，
 * 而不是让一张已经取消的单自己活过来——那会让「取消」这个状态失去任何含义。
 *
 * @packageDocumentation
 */

import { computeRenewal, type ComputeRenewalResult } from '@taizan/billing-rules'

/** 订单状态，与 `02-plan.prisma` 的 `PlanOrderStatus` 逐字符一致。 */
export type PlanOrderStatus = 'PENDING' | 'PAID' | 'FULFILLED' | 'CANCELLED' | 'REFUNDED'

/** 订单类型，与 `02-plan.prisma` 的 `PlanOrderType` 逐字符一致。 */
export type PlanOrderType = 'OPEN' | 'RENEW' | 'UPGRADE'

/**
 * 允许的状态迁移表。**这是整个收费闭环唯一的一张真值表**，服务层只准问它。
 *
 * `PAID` 是一个瞬时状态：它和 `FULFILLED` 发生在同一个事务里（先置 PAID 再置
 * FULFILLED，好让「付了钱但权益没发」在事故现场是一个**可查询**的状态而不是靠猜）。
 * 所以 `PAID` 的出边只有 `FULFILLED`——没有 `PAID → CANCELLED`，钱都收了不能一取了之。
 */
export const PLAN_ORDER_TRANSITIONS: Readonly<Record<PlanOrderStatus, readonly PlanOrderStatus[]>> =
  Object.freeze({
    PENDING: ['PAID', 'CANCELLED'],
    PAID: ['FULFILLED'],
    FULFILLED: ['REFUNDED'],
    CANCELLED: [],
    REFUNDED: [],
  })

/** `from → to` 这条边存在吗。 */
export function canTransition(from: PlanOrderStatus, to: PlanOrderStatus): boolean {
  return PLAN_ORDER_TRANSITIONS[from].includes(to)
}

/** 迁移不合法时抛出。服务层把它翻译成 `BizException`。 */
export class PlanOrderTransitionError extends Error {
  override readonly name = 'PlanOrderTransitionError'
  constructor(
    readonly from: PlanOrderStatus,
    readonly to: PlanOrderStatus,
  ) {
    super(
      `套餐订单不能从 ${from} 变成 ${to}（${from} 允许的下一步：` +
        `${PLAN_ORDER_TRANSITIONS[from].join(' / ') || '无，这是终态'}）`,
    )
  }
}

/**
 * 断言一次状态迁移合法。
 *
 * @throws {@link PlanOrderTransitionError}
 */
export function assertTransition(from: PlanOrderStatus, to: PlanOrderStatus): void {
  if (!canTransition(from, to)) throw new PlanOrderTransitionError(from, to)
}

/** 未支付订单的存活时长：30 分钟（蓝图 §4.6）。 */
export const PLAN_ORDER_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 超时取消的时间下界：`createdAt` 早于这一刻的 `PENDING` 单都该取消。
 *
 * 做成「算一个 cutoff」而不是「逐行比 now - createdAt」，是为了让 cron 能把它直接
 * 写进 `where`——一次 `updateMany` 解决，而不是先 `findMany` 再逐行更新（那种写法在
 * 积压了几万张废单的库上会把内存吃光）。
 */
export function timeoutCutoff(now: Date): Date {
  return new Date(now.getTime() - PLAN_ORDER_TIMEOUT_MS)
}

/** 这张 `PENDING` 单超时了吗（含边界：恰好 30 分钟算**没**超时）。 */
export function isTimedOut(createdAt: Date, now: Date): boolean {
  return createdAt.getTime() < timeoutCutoff(now).getTime()
}

/** {@link computeOrderAmount} 的入参。 */
export interface OrderAmountInput {
  /** `Plan.firstPriceCents`：首次开通价。 */
  firstPriceCents: number
  /** `Plan.renewPriceCents`：续费价，通常比首开便宜。 */
  renewPriceCents: number
  /** 买几个计费周期。 */
  periods: number
  /**
   * 这家店此前有没有**成功兑现过**的套餐订单。
   *
   * 判据刻意是「有没有 FULFILLED 过」而不是「`Tenant.planId` 是否为空」：
   * 平台后台可以直接给一家店挂套餐（`change-plan`）而没有任何订单，那种店再来买
   * 仍然是第一次付钱，该走首开价。反过来，退过款的店也算付过——`REFUNDED` 的前身
   * 是 `FULFILLED`，它确实享受过一段服务。
   */
  hasFulfilledBefore: boolean
}

/** 一次下单的金额（分）= 单价 × 周期数。 */
export function computeOrderAmount(input: OrderAmountInput): number {
  assertPositiveInt(input.periods, 'periods')
  const unit = input.hasFulfilledBefore ? input.renewPriceCents : input.firstPriceCents
  if (!Number.isInteger(unit) || unit < 0) {
    throw new RangeError(`套餐单价必须是非负整数分，收到 ${String(unit)}`)
  }
  return unit * input.periods
}

/** {@link resolveOrderType} 的入参。 */
export interface OrderTypeInput {
  hasFulfilledBefore: boolean
  /** 租户当前挂的套餐（`Tenant.planId`）。 */
  currentPlanId: string | null
  /** 这次买的套餐。 */
  targetPlanId: string
}

/**
 * 订单类型：没付过钱是 `OPEN`，付过且换了套餐是 `UPGRADE`，其余是 `RENEW`。
 *
 * `UPGRADE` 在本阶段只是一个**标签**（差价补退是后续的事），但类型必须现在就分对：
 * 事后拿历史订单做营收口径统计时，「换套餐」和「续同一档」是两笔完全不同的生意，
 * 而这两者的区别在事后从 `planId` 反推不出来（租户当时挂的是哪档已经被覆盖了）。
 */
export function resolveOrderType(input: OrderTypeInput): PlanOrderType {
  if (!input.hasFulfilledBefore) return 'OPEN'
  if (input.currentPlanId !== null && input.currentPlanId !== input.targetPlanId) return 'UPGRADE'
  return 'RENEW'
}

/** {@link computeFulfillPeriod} 的入参。 */
export interface FulfillPeriodInput {
  /** 履约前租户的到期日；`null` = 从未开通过。 */
  currentExpireAt: Date | null
  now: Date
  periods: number
  /** `Plan.periodMonths`。 */
  periodMonths: number
}

/**
 * 履约后的到期日 = `max(原到期日, now)` 起加 `periods × periodMonths` 个日历月，
 * 落在 `Asia/Shanghai` 当天的 `23:59:59.999`。
 *
 * 算法本体在 `@taizan/billing-rules` 的 `computeRenewal`，这里只是一层**命名转发**——
 * 存在的意义是让本文件成为「套餐订单要用到的所有算法」的单一入口，服务层不用同时
 * import 两个地方；顺带让 `expireBeforeAt` / `expireAfterAt` 这两个落库列名在
 * 类型上就和订单表对上。
 */
export function computeFulfillPeriod(input: FulfillPeriodInput): ComputeRenewalResult {
  return computeRenewal({
    currentExpireAt: input.currentExpireAt,
    now: input.now,
    periods: input.periods,
    periodMonths: input.periodMonths,
  })
}

/**
 * 回调金额与订单金额是否一致。
 *
 * **必须比对**：回调报文里的钱才是真收到的钱。不比的后果是「用户改了收银台的金额
 * 参数、付了 1 分钱、拿到一年套餐」——而这条链路上没有任何别的环节会发现。
 */
export function isAmountMatch(orderAmountCents: number, paidAmountCents: number): boolean {
  return orderAmountCents === paidAmountCents
}

/** 兑现（fulfill）之后租户该是什么状态；`null` = 不动它。 */
export function nextTenantStatus(current: string): 'ACTIVE' | null {
  // 续过费说明不再是「只试用没付过钱」。SUSPENDED（平台人工封的）与 DEREGISTERED
  // **不因付款自动解除**——冻结/注销和欠费是两件独立的事，付钱只解决欠费那一半。
  return current === 'TRIAL' ? 'ACTIVE' : null
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} 必须是正整数，收到 ${String(value)}`)
  }
}
