/**
 * 支付域的金额工具。
 *
 * 「分」的基本校验复用 `@taizan/contracts` 的 {@link assertCents}（单一真源，
 * 本包不重新实现一份），这里只加支付特有的一件事：**按比例拆分**。
 */
import { assertCents } from '@taizan/contracts'

export { assertCents }

/**
 * 把一笔金额按权重拆成若干份，**余数给第一份**，保证 `sum(结果) === totalCents`。
 *
 * ## 为什么必须「总和不变」
 *
 * 分账最常见的线上事故就是四舍五入之后各份加起来比订单多了一分，
 * 微信直接回「分账金额超过可分金额」，**整笔分账失败**——不是少分一分，是一分都没分成。
 * 所以这里每一份都向下取整，把攒下来的余数一次性补给第一份（约定第一份是平台/主收款方）。
 *
 * ## 为什么权重是数组而不是 bps
 *
 * bps（万分比）要求调用方自己保证加起来是 10000，加一个接收方就要重算全部。
 * 传相对权重则由本函数归一化：`[7, 3]` 与 `[70, 30]` 与 `[0.7, 0.3]` 结果相同。
 *
 * @param totalCents - 待拆分总额（分，非负安全整数）
 * @param weights - 各份的相对权重，至少一项，每项非负且不能全为 0
 * @returns 与 `weights` 等长的整数数组，总和恒等于 `totalCents`
 *
 * @example
 * ```ts
 * splitAmount(100, [1, 1, 1])   // [34, 33, 33]  余 1 给第一份
 * splitAmount(999, [7, 3])      // [700, 299]
 * splitAmount(0, [1, 2])        // [0, 0]
 * ```
 */
export function splitAmount(totalCents: number, weights: readonly number[]): number[] {
  assertCents(totalCents, 'totalCents')
  if (totalCents < 0) {
    throw new Error(`[@taizan/payment-core] splitAmount() 的 totalCents 不能为负：${totalCents}`)
  }
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new Error('[@taizan/payment-core] splitAmount() 至少需要一个权重')
  }
  let sum = 0
  for (const w of weights) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      throw new Error(`[@taizan/payment-core] splitAmount() 的权重必须是非负有限数：${String(w)}`)
    }
    sum += w
  }
  if (sum <= 0) {
    throw new Error('[@taizan/payment-core] splitAmount() 的权重不能全为 0（拆不出任何一份）')
  }

  const parts = weights.map((w) => Math.floor((totalCents * w) / sum))
  const allocated = parts.reduce((a, b) => a + b, 0)
  // 余数一定在 [0, weights.length) 内：每份最多被向下取整丢掉不到 1 分。
  parts[0] = (parts[0] ?? 0) + (totalCents - allocated)
  return parts
}

/**
 * 按万分比算抽佣金额（分），**向下取整**。
 *
 * 搬自 knowledge `payment/wechat/profit-sharing.rules.ts`：向下取整而不是四舍五入，
 * 理由同 {@link splitAmount}——宁可平台少收一分，也不能让分账金额超过可分余额。
 *
 * @param baseCents - 计算基数（通常是订单实付金额，分）
 * @param rateBps - 抽佣万分比（如 1000 = 10%）
 * @param maxBps - 上限万分比，默认 3000（微信规定单笔分账不得超过订单金额的 30%）
 */
export function calcCommissionCents(baseCents: number, rateBps: number, maxBps = 3000): number {
  if (!Number.isFinite(baseCents) || !Number.isFinite(rateBps)) return 0
  if (baseCents <= 0 || rateBps <= 0) return 0
  const capped = Math.min(rateBps, maxBps)
  return Math.floor((baseCents * capped) / 10_000)
}
