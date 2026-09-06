/**
 * 套餐 seed：两档（体验版 / 标准版），顺带把「配额三态」与「功能三态」各演示一遍。
 *
 * 三态是这套框架里最容易被写坏的一处约定，所以 seed 数据本身就是它的活文档：
 * - 配额 `null` = 不限，`0` = 禁用，正整数 = 上限。**三者互不等价**，清空必须显式传 `null`。
 * - 功能 `features: null` = 全部功能开放，`[]` = 一个都不开。
 *
 * 体验版 STAFF = 3（有上限）、TRAFFIC_MB = 0（禁用），标准版 STAFF = null（不限），
 * 三种取值在同一份 seed 里都出现过一次，谁把 `null` 当 `0` 处理，跑一遍就能被发现。
 */

import type { SeedDelegate } from './types'

/** 体验版套餐 code。 */
export const TRIAL_PLAN_CODE = 'trial'

/** 标准版套餐 code。 */
export const STANDARD_PLAN_CODE = 'standard'

/** 一档套餐的 seed 数据。 */
export interface PlanSeedSpec {
  /** 稳定标识。 */
  code: string
  /** 展示名。 */
  name: string
  /** 首开价（分）。 */
  firstPriceCents: number
  /** 续费价（分）。 */
  renewPriceCents: number
  /** 计费周期月数。 */
  periodMonths: number
  /** 配额三态，key 取自 QuotaKind。 */
  quotas: Record<string, number | null>
  /** 功能白名单；`null` = 全部。 */
  features: string[] | null
  /** 允许接入的端。 */
  appKeys: string[]
  /** 月流量额度（MB）。 */
  trafficMb: number
  /** 排序。 */
  sort: number
}

/** 框架内置的两档套餐。 */
export const BASE_PLAN_SEEDS: readonly PlanSeedSpec[] = [
  {
    code: TRIAL_PLAN_CODE,
    name: '体验版',
    firstPriceCents: 0,
    renewPriceCents: 0,
    periodMonths: 1,
    quotas: {
      // 有上限：最多 3 个员工。
      STAFF: 3,
      STORE: 1,
      MEMBER: 200,
      STORAGE_MB: 512,
      // 禁用：0 不是「不限」，是一点都不给。
      TRAFFIC_MB: 0,
    },
    // 只开这两块功能；`[]` 会是「一块都不开」，与 null（全开）都不一样。
    features: ['member', 'order'],
    appKeys: ['admin', 'client'],
    trafficMb: 0,
    sort: 10,
  },
  {
    code: STANDARD_PLAN_CODE,
    name: '标准版',
    firstPriceCents: 99_800,
    renewPriceCents: 79_800,
    periodMonths: 12,
    quotas: {
      // 不限：null，写 0 就成了「不许加员工」。
      STAFF: null,
      STORE: 5,
      MEMBER: null,
      STORAGE_MB: 10_240,
      TRAFFIC_MB: 51_200,
    },
    // null = 全部功能开放。
    features: null,
    appKeys: ['admin', 'client', 'app'],
    trafficMb: 51_200,
    sort: 20,
  },
]

/** {@link seedPlans} 的入参。 */
export interface SeedPlansInput {
  /** `prisma.plan` */
  delegate: SeedDelegate
  /** 主键生成器。 */
  newId: () => string
  /** 要写入的套餐，默认 {@link BASE_PLAN_SEEDS}。 */
  specs?: readonly PlanSeedSpec[]
}

/**
 * 幂等地写入套餐。
 *
 * 与管理员口令不同，套餐的价格与配额**每次都覆盖**：它们是框架/运营定义的产品参数，
 * seed 就是它们的真源，手工在库里改完不同步回代码本来就是要被覆盖掉的。
 *
 * @param input - 见 {@link SeedPlansInput}
 * @returns code → \{ id, code \} 的映射
 */
export async function seedPlans(
  input: SeedPlansInput,
): Promise<Record<string, { id: string; code: string }>> {
  const specs = input.specs ?? BASE_PLAN_SEEDS
  const out: Record<string, { id: string; code: string }> = {}
  for (const spec of specs) {
    const payload = {
      name: spec.name,
      firstPriceCents: spec.firstPriceCents,
      renewPriceCents: spec.renewPriceCents,
      periodMonths: spec.periodMonths,
      quotas: spec.quotas,
      features: spec.features,
      appKeys: spec.appKeys,
      trafficMb: spec.trafficMb,
      status: 'ENABLED',
      sort: spec.sort,
    }
    const row = await input.delegate.upsert({
      where: { code: spec.code },
      create: { id: input.newId(), code: spec.code, ...payload },
      update: payload,
    })
    out[spec.code] = { id: row.id, code: spec.code }
  }
  return out
}
