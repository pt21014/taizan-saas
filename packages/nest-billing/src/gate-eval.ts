/**
 * 「算两遍」的那个小助手：一遍按开关的真实值算（决定放不放行），一遍按
 * `enforcing: true` 算（决定要不要打 warn）。
 *
 * ## 为什么不在守卫里写 `if (!enforcing) return true`
 *
 * 因为 `BILLING_ENFORCE` **不是**一个「全放行」的开关：冻结（SUSPENDED）与注销
 * （DEREGISTERED）是平台逐个店铺按下去的，按下去就该立刻生效，开关掀不动它们
 * （蓝图 §4.5）。这条区分已经写在 `evaluateTenantGate` 里了——它对硬闸门走 `hard()`
 * 分支，`enforcing` 根本不参与。守卫这边再写一次 `if (!enforcing)` 就等于把这条
 * 区分复制了一份，而两份里晚改的那份迟早会漏掉一种状态。
 *
 * 所以这里的做法是：**两次调用同一个规则函数，只改 `enforcing` 入参**。
 * 判定权 100% 留在 `@taizan/billing-rules`，本文件只负责比对两次的结果。
 *
 * knowledge 的老实现踩过的坑正是这个：`tenant-billing.service.ts` 里
 * `if (!result.allow && !this.enforcing && result.code === 'EXPIRED')` 这行 ——
 * 靠 `result.code === 'EXPIRED'` 手工把硬闸门摘出去，后台跟着开关一起放行，
 * 于是开关关着时冻结一家店的实际效果是「学员立刻进不去，商家后台还能写满 7 天」。
 *
 * @packageDocumentation
 */

import {
  evaluateTenantGate,
  gateToErrorCode,
  type GateSide,
  type TenantGateInput,
  type TenantGateResult,
} from '@taizan/billing-rules'
import type { TenantGateView } from './platform-gateway'

/** 两次求值的结果。 */
export interface ShadowGateResult {
  /** 按开关真实值算出来的结论——放不放行看它。 */
  effective: TenantGateResult
  /** 按 `enforcing: true` 算出来的结论——「打开开关会怎样」看它。 */
  strict: TenantGateResult
  /** 生效的错误码（`null` = 放行）。 */
  code: number | null
  /**
   * 开关关着、本该拦下却放行了。
   *
   * 这正是 `deploy/checks/billing-check.sh` 要回答的「谁会被锁」的运行时那一半：
   * 脚本回答部署前的静态影响面，这个标记回答线上真实发生过的请求。
   */
  shadowed: boolean
}

/** 从闸门视图拼出规则函数要的入参（除了 `now` 与 `enforcing`）。 */
export function gateInputOf(view: TenantGateView, now: Date, enforcing: boolean): TenantGateInput {
  return {
    now,
    status: view.status,
    planExpireAt: view.planExpireAt,
    trialEndAt: view.trialEndAt,
    graceDays: view.graceDays,
    enforcing,
  }
}

/** 算两遍。 */
export function evaluateWithShadow(
  view: TenantGateView,
  now: Date,
  enforcing: boolean,
  side: GateSide,
): ShadowGateResult {
  const strict = evaluateTenantGate(gateInputOf(view, now, true))
  // 开关开着时两遍是同一个结论，省一次调用；关着时才真的算第二遍。
  const effective = enforcing ? strict : evaluateTenantGate(gateInputOf(view, now, false))
  const code = gateToErrorCode(effective, side)
  return {
    effective,
    strict,
    code,
    shadowed: code === null && gateToErrorCode(strict, side) !== null,
  }
}

/** warn 文案。格式与 knowledge 的 `[BILLING_ENFORCE=false] 若开启将拦下：…` 保持一致，便于 grep 日志。 */
export function shadowWarning(
  view: TenantGateView,
  result: ShadowGateResult,
  method: string,
  path: string,
): string {
  return (
    `[BILLING_ENFORCE=false] 若开启将拦下：tenant=${view.tenantId}(${view.slug}) ` +
    `${method} ${path} 理由=${String(result.strict.reason)} 阶段=${result.strict.phase}`
  )
}
