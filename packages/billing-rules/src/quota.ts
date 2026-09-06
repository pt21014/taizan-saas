/**
 * 配额三态判定。**`null` ≠ `0` ≠ 缺省**，这是四条不可退让的第 3 条（见 `index.ts` 文件头）。
 *
 * - `null` = **不限量**；
 * - `0` = **一个都不给**（平台故意关掉这个维度）；
 * - 正整数 = 上限；
 * - **缺省（key 不存在）** = 这个套餐没定义过这个维度 → 按不限量处理，见 {@link resolveQuota}。
 *
 * 三态合并成一个数字（比如用 `0`/`-1` 表示不限）的代价是具体的：
 * 平台想给某个演示店关掉「员工」这个维度，只能填 `0`，而 `0` 又被当成「不限」，
 * 于是那家店可以无限加员工——错的方向永远是「白送」，而白送不会有人报障。
 */

import { ErrorCode } from '@taizan/contracts'

/** {@link checkQuota} 的结果。 */
export interface QuotaCheckResult {
  /** 这次消耗是否允许。 */
  ok: boolean
  /** 不允许的原因。目前只有一种：超限。 */
  reason?: 'EXCEEDED'
  /** 生效的上限，`null` = 不限量。原样回传，方便直接拼提示文案。 */
  limit: number | null
  /** 已用量。 */
  used: number
  /** 本次要消耗的量。 */
  delta: number
  /** 本次消耗后还剩多少；不限量时为 `null`，已超时为 `0`（不返回负数，界面上没有「剩 -3 个」）。 */
  remaining: number | null
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`[@taizan/billing-rules] ${label} 必须是非负整数，收到 ${String(value)}`)
  }
}

/**
 * 配额判定：`used + delta <= limit` 才放行。
 *
 * **`limit = 0` 与 `limit = null` 走的是同一行算术、得出相反的结论**，这正是三态的意义：
 * `0` 时 `0 + 1 <= 0` 为假 → 一个都不给；`null` 时根本不比 → 不限量。
 *
 * 入参非法（负数、小数、`NaN`）一律抛 `RangeError` 而不是「宽容地当成不限量」：
 * 配额数来自 `Plan.quotas` 这个 Json 列，存坏了要在开发/联调期就炸出来，
 * 而不是等到某家店无限白嫖三个月之后在对账表上被发现。归一化脏数据是 {@link resolveQuota} 上游的事。
 *
 * @param limit - 上限。`null` = 不限量，`0` = 一个都不给
 * @param used - 已用量（非负整数）
 * @param delta - 本次要消耗的量，默认 `1`。传 `0` 表示「只看当前是否已超」，不消耗
 * @returns 见 {@link QuotaCheckResult}
 * @throws RangeError - `limit`（非 `null` 时）/ `used` / `delta` 不是非负整数
 *
 * @example
 * ```ts
 * checkQuota(null, 9999)   // { ok: true,  limit: null, remaining: null }
 * checkQuota(0, 0)         // { ok: false, reason: 'EXCEEDED', limit: 0, remaining: 0 }
 * checkQuota(3, 2)         // { ok: true,  limit: 3, remaining: 0 }
 * checkQuota(3, 3)         // { ok: false, reason: 'EXCEEDED', limit: 3, remaining: 0 }
 * ```
 */
export function checkQuota(limit: number | null, used: number, delta = 1): QuotaCheckResult {
  if (limit !== null) assertNonNegativeInt(limit, 'limit')
  assertNonNegativeInt(used, 'used')
  assertNonNegativeInt(delta, 'delta')

  if (limit === null) {
    return { ok: true, limit: null, used, delta, remaining: null }
  }
  const after = used + delta
  if (after > limit) {
    return {
      ok: false,
      reason: 'EXCEEDED',
      limit,
      used,
      delta,
      remaining: Math.max(0, limit - used),
    }
  }
  return { ok: true, limit, used, delta, remaining: limit - after }
}

/**
 * 套餐里那张配额表的形状（`Plan.quotas` 反序列化之后）。key 取值见 schema 的 `QuotaKind`。
 *
 * 值为 `null` 表示该维度显式不限量；key 缺省表示该套餐没定义过这个维度。
 */
export type PlanQuotas = Record<string, number | null>

/**
 * 算出某个维度此刻生效的上限：**租户级覆盖优先，套餐兜底**。
 *
 * 三条优先级规则，每一条都对应一件平台运营真的会做的事：
 * - `override === undefined`（不传 / 租户没有这一项覆盖）→ **不覆盖**，用套餐里的值。
 *   这是绝大多数租户；
 * - `override === null` → **显式不限量**。平台给某个大客户单独放开某个维度，
 *   不该因为「`null` 看起来像没填」就退回套餐上限；
 * - `override` 是数字 → 用它，包括 `0`（单独把某家店的这个维度关掉）。
 *
 * **套餐里 key 缺省时按不限量（`null`）处理**，这是蓝图没写死、本包拍的板：
 * 将来往 `QuotaKind` 里加一个新维度时，存量套餐的 Json 里都没有这个 key，
 * 若按「一个都不给」处理，加维度的当天全平台商家会集体撞上这个新配额——
 * 那种上线事故当场就是全量的。少收一点钱可以补收，锁错一批店补不回来。
 * 平台真想关掉某个维度，显式写 `0`。
 *
 * @param planQuotas - 套餐配额表，见 {@link PlanQuotas}
 * @param kind - 配额维度 key（`QuotaKind` 的取值）
 * @param override - 租户级覆盖：`undefined` 不覆盖 / `null` 显式不限 / 数字为上限
 * @returns 生效的上限，`null` = 不限量
 * @throws RangeError - 取出来的值不是 `null` 也不是非负整数（`Plan.quotas` 存坏了）
 */
export function resolveQuota(
  planQuotas: PlanQuotas,
  kind: string,
  override?: number | null,
): number | null {
  const resolved =
    override !== undefined
      ? override
      : Object.prototype.hasOwnProperty.call(planQuotas, kind)
        ? (planQuotas[kind] ?? null)
        : null
  if (resolved !== null) {
    assertNonNegativeInt(resolved, `quotas.${kind}`)
  }
  return resolved
}

/**
 * 配额超限对应的 7 位错误码 `1540301`。
 *
 * **与套餐到期 `1440301`、功能未包含 `1540302` 刻意分开**：三道闸门并列不合并。
 * 商家看到「已达到套餐配额上限」知道去升套餐或清理，看到「套餐已到期」知道去续费——
 * 合成一个「无权限」他只会打客服电话。
 */
export const QUOTA_EXCEEDED_CODE: number = ErrorCode.QUOTA_EXCEEDED.code

/**
 * 把配额判定结果映射成错误码：超限返回 `1540301`，放行返回 `null`。
 *
 * @param result - {@link checkQuota} 的结果
 */
export function quotaToErrorCode(result: QuotaCheckResult): number | null {
  return result.ok ? null : QUOTA_EXCEEDED_CODE
}
