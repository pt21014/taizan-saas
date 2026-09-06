/**
 * 到期闸门：一个纯函数回答「这家租户此刻后台能不能写、C 端开不开门、为什么、还剩几天」。
 *
 * ## 四条不可退让（改本文件前先读完）
 *
 * 1. **到期永远现算。** `TenantStatus` 刻意没有 `EXPIRED`——存了状态位就得有人负责在到期那一刻改它，
 *    定时任务漏跑一次商家就免费用下去，而且这种漏跑不报错、没人会发现。
 * 2. **续费路径永远可写。** 见 `renewal.ts`。锁住续费入口 = 「到期 → 只读 → 续不了费 → 永远到期」死循环。
 * 3. **配额与功能都是三态。** 见 `quota.ts` / `feature.ts`，`null` ≠ `0` ≠ `[]`。
 * 4. **`BILLING_ENFORCE` 默认关。** 关着时照常算、照常给出 `reason`/`phase`/`daysLeft` 供日志 warn 与
 *    `billing-check.sh` 先回答「谁会被锁」，只是不真拦。
 *
 * ## 三道闸门并列不合并
 *
 * 套餐到期（`1440301`/`1440302`）、配额超限（`1540301`）、功能未包含（`1540302`）是三个独立的码。
 * 合成一个笼统的「无权限」，商家只会来问客服——他不知道该去续费、还是去升套餐、还是去删两个员工。
 */

import { ErrorCode } from '@taizan/contracts'

import {
  DEFAULT_TIMEZONE,
  addCalendarDays,
  assertValidDate,
  calendarDayOf,
  diffCalendarDays,
  endOfCalendarDay,
  endOfDayInZone,
} from './period'

/**
 * 与 `prisma-base` 的 `TenantStatus` 对齐。**刻意没有 `EXPIRED`**——到期现算（不可退让第 1 条）。
 *
 * 用字符串联合而不是 import 生成的 Prisma enum，是为了让本包保持零框架依赖、能在裸 node 里跑单测。
 */
export type TenantStatusLike = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'DEREGISTERED'

/**
 * 闸门算出来的生命周期阶段。**这是给人看的那一列**（日志、平台后台租户列表、`billing-check.sh`），
 * 与 `adminWritable`/`clientOpen` 分开：后两个受 `enforcing` 影响，`phase` 永远是真实情况。
 *
 * - `ACTIVE` / `TRIAL`：未到期，正常；
 * - `GRACE`：已过到期日但还在宽限期内；
 * - `EXPIRED`：过了宽限期；
 * - `SUSPENDED` / `DEREGISTERED`：平台按下去的，与计费无关；
 * - `PENDING`：**未开通**——没有任何到期日可算（`planExpireAt` 与 `trialEndAt` 皆空）。
 *   本框架没有 `PENDING` 状态位，所以它也是现算出来的。
 */
export type GatePhase =
  'ACTIVE' | 'TRIAL' | 'GRACE' | 'EXPIRED' | 'SUSPENDED' | 'DEREGISTERED' | 'PENDING'

/** 闸门不通过（或即将不通过）的原因。完全正常时为 `null`。 */
export type GateReason = 'SUSPENDED' | 'DEREGISTERED' | 'PENDING' | 'GRACE' | 'EXPIRED'

/** {@link evaluateTenantGate} 的入参。 */
export interface TenantGateInput {
  /** 现在。由调用方注入，规则函数自己不读时钟（否则没法测边界时刻）。 */
  now: Date
  /** 租户状态，见 {@link TenantStatusLike}。 */
  status: TenantStatusLike
  /** 套餐到期日；`null` = 没有套餐。 */
  planExpireAt: Date | null
  /** 试用到期日。`status === 'TRIAL'` 时优先用它算，缺省时回落到 `planExpireAt`。 */
  trialEndAt?: Date | null
  /** 宽限天数（`Tenant.graceDays`，默认 0）。到期后这几天后台仍可写、C 端仍开门，但会给出 `GRACE`。 */
  graceDays: number
  /** `BILLING_ENFORCE`。`false` 时不真拦，但照常算 `reason`/`phase`/`daysLeft`。 */
  enforcing: boolean
  /** 计算「当天」用的时区，默认 {@link DEFAULT_TIMEZONE}。不依赖进程时区。 */
  timezone?: string
}

/** {@link evaluateTenantGate} 的结果。 */
export interface TenantGateResult {
  /** 商家后台是否允许写操作。续费白名单不受这个字段管，见 `isRenewalPath`。 */
  adminWritable: boolean
  /** C 端店铺是否开门。 */
  clientOpen: boolean
  /** 不通过（或即将不通过）的原因；完全正常时 `null`。**`enforcing=false` 也照常给。** */
  reason: GateReason | null
  /**
   * 距离到期日还有几个**日历日**：正数 = 还剩几天，`0` = 今天到期，负数 = 已过期几天。
   * 没有任何到期日可算（`PENDING`）时为 `null`。到期提醒 cron 的 T-7/T-3/T-1/T+0/T+3 直接读这个数。
   */
  daysLeft: number | null
  /** 真实生命周期阶段，不受 `enforcing` 影响。 */
  phase: GatePhase
  /** 原样回传入参的 `enforcing`，方便日志里一眼看出这条结果是不是「算了但没拦」。 */
  enforcing: boolean
}

/**
 * 到期闸门主判定。**纯函数，不碰数据库、不读时钟、不读进程时区。**
 *
 * ## 判定顺序（顺序本身就是规则）
 *
 * 1. **`SUSPENDED` / `DEREGISTERED` 与 `enforcing` 无关**，永远不可写、不开放。
 *    那是平台逐个按下去的开关，不该被一个全局的「计费不强制执行」环境变量掀翻——
 *    否则把 `BILLING_ENFORCE` 关掉排查问题时，所有被封的违规店会一起恢复营业。
 * 2. **没有任何到期日可算 → `PENDING`（未开通）。** 受 `enforcing` 管：它是计费闸门的一部分，
 *    而不是平台按下去的开关（本框架 `TenantStatus` 里没有 `PENDING` 这一位，见 {@link GatePhase}）。
 * 3. **到期日按「日」比，当天整天算未到期。** `23:59:59` 仍可写，次日 `00:00:00` 才锁。
 *    时区取 `input.timezone`，默认 {@link DEFAULT_TIMEZONE}。
 * 4. **宽限期内后台可写、C 端仍开门**，但 `reason` 给出 `GRACE`——用来在后台顶部挂条催费横幅，
 *    而不是直接锁人。宽限期的意义就是「别在半夜把正在做生意的店锁了」。
 * 5. **过了宽限期：后台只读、C 端打烊。** 读操作与续费白名单由上层放行，本函数不管路径。
 *
 * @param input - 见 {@link TenantGateInput}
 * @returns 见 {@link TenantGateResult}
 *
 * @example
 * ```ts
 * const gate = evaluateTenantGate({
 *   now: new Date(),
 *   status: 'ACTIVE',
 *   planExpireAt: tenant.planExpireAt,
 *   graceDays: tenant.graceDays,
 *   enforcing: env.BILLING_ENFORCE,
 * })
 * if (!gate.adminWritable && !isRenewalPath(req.path)) {
 *   throw new BizException(gateToErrorCode(gate, 'admin')!)
 * }
 * ```
 */
export function evaluateTenantGate(input: TenantGateInput): TenantGateResult {
  const { now, status, planExpireAt, graceDays, enforcing } = input
  const timeZone = input.timezone ?? DEFAULT_TIMEZONE
  assertValidDate(now, 'now')
  if (planExpireAt !== null) assertValidDate(planExpireAt, 'planExpireAt')
  const trialEndAt = input.trialEndAt ?? null
  if (trialEndAt !== null) assertValidDate(trialEndAt, 'trialEndAt')
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    throw new RangeError(
      `[@taizan/billing-rules] graceDays 必须是非负整数，收到 ${String(graceDays)}`,
    )
  }

  // 试用中的租户用 trialEndAt 算；它没设的话回落到 planExpireAt（平台后台改过套餐的试用店会是这种）。
  const anchor = status === 'TRIAL' ? (trialEndAt ?? planExpireAt) : planExpireAt
  const daysLeft = anchor === null ? null : diffCalendarDays(now, anchor, timeZone)

  // ── 1. 硬闸门：平台按下去的，enforcing 掀不动 ──
  if (status === 'SUSPENDED') {
    return hard('SUSPENDED', 'SUSPENDED', daysLeft, enforcing)
  }
  if (status === 'DEREGISTERED') {
    return hard('DEREGISTERED', 'DEREGISTERED', daysLeft, enforcing)
  }

  // ── 2. 未开通 ──
  if (anchor === null) {
    return soft('PENDING', 'PENDING', false, false, null, enforcing)
  }

  // ── 3. 到期按「日」比：当天 23:59:59 仍算未到期 ──
  const expireEnd = endOfDayInZone(anchor, timeZone)
  if (now.getTime() <= expireEnd.getTime()) {
    const phase: GatePhase = status === 'TRIAL' ? 'TRIAL' : 'ACTIVE'
    return soft(phase, null, true, true, daysLeft, enforcing)
  }

  // ── 4. 宽限期：后台可写、C 端仍开门，但要给出理由 ──
  const graceEnd = endOfCalendarDay(
    addCalendarDays(calendarDayOf(anchor, timeZone), graceDays),
    timeZone,
  )
  if (now.getTime() <= graceEnd.getTime()) {
    return soft('GRACE', 'GRACE', true, true, daysLeft, enforcing)
  }

  // ── 5. 过宽限期：后台只读、C 端打烊 ──
  return soft('EXPIRED', 'EXPIRED', false, false, daysLeft, enforcing)
}

/** 硬闸门结果：无视 `enforcing`。 */
function hard(
  phase: GatePhase,
  reason: GateReason,
  daysLeft: number | null,
  enforcing: boolean,
): TenantGateResult {
  return { adminWritable: false, clientOpen: false, reason, daysLeft, phase, enforcing }
}

/** 计费闸门结果：`enforcing=false` 时放行，但 `reason`/`phase`/`daysLeft` 照常给。 */
function soft(
  phase: GatePhase,
  reason: GateReason | null,
  adminWritable: boolean,
  clientOpen: boolean,
  daysLeft: number | null,
  enforcing: boolean,
): TenantGateResult {
  return {
    adminWritable: enforcing ? adminWritable : true,
    clientOpen: enforcing ? clientOpen : true,
    reason,
    daysLeft,
    phase,
    enforcing,
  }
}

/** {@link gateToErrorCode} 的两侧。 */
export type GateSide = 'admin' | 'client'

/**
 * 把闸门结果映射成 7 位错误码：后台 `1440301`（去续费）、C 端 `1440302`（已打烊）。
 *
 * **按 `adminWritable`/`clientOpen` 判，不按 `reason` 判**——所以 `enforcing=false` 时返回 `null`（放行），
 * 宽限期内也返回 `null`（`reason='GRACE'` 只用来挂横幅）。
 * 想知道「不强制执行时谁会被锁」，读 `phase`/`reason`，别读这个函数（`billing-check.sh` 走的就是前者）。
 *
 * 这两个码与配额 `1540301`、功能 `1540302` 刻意分开——三道闸门并列不合并。
 *
 * @param result - {@link evaluateTenantGate} 的结果
 * @param side - `admin` 商家后台写操作 / `client` C 端访问
 * @returns 被拦时返回错误码，放行时返回 `null`
 */
export function gateToErrorCode(result: TenantGateResult, side: GateSide): number | null {
  if (side === 'admin') {
    return result.adminWritable ? null : ErrorCode.PLAN_READONLY.code
  }
  return result.clientOpen ? null : ErrorCode.SHOP_CLOSED.code
}
