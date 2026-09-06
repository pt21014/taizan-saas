/**
 * 套餐的**业务规则纯函数**（蓝图 §9）。
 *
 * 三态是这套框架里最容易被写坏的一处约定（`@taizan/billing-rules` 文件头「四条不可退让」
 * 的第 ④ 条），所以校验规则单独抽出来，不碰数据库、不依赖 Nest，能被 `plan.rules.spec.ts`
 * 把每种取值组合都过一遍：
 *
 * - **配额** `quotas`：`{"STAFF": 3}` 上限、`{"STAFF": 0}` 禁用、`{"STAFF": null}` 不限、
 *   key 缺省（这个维度这份 patch 根本没提）按 `@taizan/billing-rules` 的 `resolveQuota`
 *   口径走「套餐没定义过 = 不限」。**接口层必须能区分「没传这个字段」与「传了 null」**，
 *   这也是为什么 DTO 上这两个字段都不给默认值——一给默认值，"缺省" 这个状态就被
 *   悄悄吃掉了。
 * - **功能白名单** `features`：`null` 全部可用、`[]` 一个都不给、非空数组是白名单。
 *
 * @packageDocumentation
 */

/** `Plan.quotas` 的 key 全集，与 `02-plan.prisma` 的 `QuotaKind` 一一对应。 */
export const QUOTA_KINDS = [
  'STAFF',
  'STORE',
  'MEMBER',
  'STORAGE_MB',
  'TRAFFIC_MB',
  'CUSTOM',
] as const

/** `Plan.status` 全集，与 `02-plan.prisma` 的 `PlanStatus` 一一对应。 */
export const PLAN_STATUSES = ['ENABLED', 'DISABLED', 'ARCHIVED'] as const

/** 套餐 code 的合法格式：小写字母开头的 kebab-case。 */
export const PLAN_CODE_PATTERN = /^[a-z][a-z0-9-]*$/

/** 一条校验结论。 */
export interface RuleViolation {
  field: string
  message: string
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * 校验一份配额表（新建时是全量，PATCH 时是要覆盖的那几个 key——两种场景校验规则相同，
 * 因为「只提供了几个 key」本身合法，缺的那些按 `resolveQuota` 的口径处理，不需要在这里补全）。
 *
 * @param quotas - `Plan.quotas` 的候选值
 */
export function validateQuotas(quotas: unknown): RuleViolation[] {
  if (quotas === undefined) return []
  if (typeof quotas !== 'object' || quotas === null || Array.isArray(quotas)) {
    return [{ field: 'quotas', message: 'quotas 必须是一个对象' }]
  }
  const violations: RuleViolation[] = []
  for (const [key, value] of Object.entries(quotas as Record<string, unknown>)) {
    if (!(QUOTA_KINDS as readonly string[]).includes(key)) {
      violations.push({ field: 'quotas', message: `quotas 里的 "${key}" 不是已知的配额维度` })
      continue
    }
    if (value !== null && !isNonNegativeInt(value)) {
      violations.push({
        field: 'quotas',
        message: `quotas.${key} 必须是 null（不限）或非负整数（上限，0 表示禁用）`,
      })
    }
  }
  return violations
}

/**
 * 校验功能白名单。`undefined`（这次 patch 不改这个字段）与 `null`（显式设为「全部可用」）
 * 都合法，二者的区分留给调用方（DTO 层用 `'features' in body` 或 class-transformer 的
 * `plainToInstance` 天然保留这个区分，这里只管值本身对不对）。
 */
export function validateFeatures(features: unknown): RuleViolation[] {
  if (features === undefined || features === null) return []
  if (!Array.isArray(features) || features.some((f) => typeof f !== 'string' || f.length === 0)) {
    return [{ field: 'features', message: 'features 必须是 null（全部可用）或非空字符串数组' }]
  }
  return []
}

/** 归一化套餐 code：去空白、转小写。 */
export function normalizePlanCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

/** 待校验的套餐核心字段（价格、周期、appKeys、trafficMb）。 */
export interface PlanCoreInput {
  code?: unknown
  name?: unknown
  firstPriceCents?: unknown
  renewPriceCents?: unknown
  periodMonths?: unknown
  appKeys?: unknown
  trafficMb?: unknown
}

/**
 * 校验套餐核心字段（新建用；PATCH 只校验传了的字段，见 {@link validatePlanCorePatch}）。
 */
export function validatePlanCoreInput(input: PlanCoreInput): RuleViolation[] {
  const violations: RuleViolation[] = []

  const code = normalizePlanCode(input.code)
  if (code.length === 0) {
    violations.push({ field: 'code', message: 'code 不能为空' })
  } else if (!PLAN_CODE_PATTERN.test(code)) {
    violations.push({ field: 'code', message: 'code 只能是小写字母开头的字母数字与连字符' })
  }

  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    violations.push({ field: 'name', message: '套餐名不能为空' })
  }

  if (!isNonNegativeInt(input.firstPriceCents)) {
    violations.push({ field: 'firstPriceCents', message: '首开价必须是非负整数（单位：分）' })
  }
  if (!isNonNegativeInt(input.renewPriceCents)) {
    violations.push({ field: 'renewPriceCents', message: '续费价必须是非负整数（单位：分）' })
  }
  if (
    typeof input.periodMonths !== 'number' ||
    !Number.isInteger(input.periodMonths) ||
    input.periodMonths < 1
  ) {
    violations.push({ field: 'periodMonths', message: '计费周期月数必须是正整数' })
  }

  if (
    !Array.isArray(input.appKeys) ||
    input.appKeys.length === 0 ||
    input.appKeys.some((k) => typeof k !== 'string' || k.length === 0)
  ) {
    violations.push({ field: 'appKeys', message: 'appKeys 必须是非空字符串数组' })
  }

  if (input.trafficMb !== undefined && !isNonNegativeInt(input.trafficMb)) {
    violations.push({ field: 'trafficMb', message: 'trafficMb 必须是非负整数' })
  }

  return violations
}

/** 校验一次**部分更新**：只校验传了的字段。 */
export function validatePlanCorePatch(input: PlanCoreInput): RuleViolation[] {
  const violations: RuleViolation[] = []
  if (input.code !== undefined) {
    const code = normalizePlanCode(input.code)
    if (code.length === 0 || !PLAN_CODE_PATTERN.test(code)) {
      violations.push({ field: 'code', message: 'code 只能是小写字母开头的字母数字与连字符' })
    }
  }
  if (
    input.name !== undefined &&
    (typeof input.name !== 'string' || input.name.trim().length === 0)
  ) {
    violations.push({ field: 'name', message: '套餐名不能为空' })
  }
  if (input.firstPriceCents !== undefined && !isNonNegativeInt(input.firstPriceCents)) {
    violations.push({ field: 'firstPriceCents', message: '首开价必须是非负整数（单位：分）' })
  }
  if (input.renewPriceCents !== undefined && !isNonNegativeInt(input.renewPriceCents)) {
    violations.push({ field: 'renewPriceCents', message: '续费价必须是非负整数（单位：分）' })
  }
  if (
    input.periodMonths !== undefined &&
    (typeof input.periodMonths !== 'number' ||
      !Number.isInteger(input.periodMonths) ||
      input.periodMonths < 1)
  ) {
    violations.push({ field: 'periodMonths', message: '计费周期月数必须是正整数' })
  }
  if (input.appKeys !== undefined) {
    if (
      !Array.isArray(input.appKeys) ||
      input.appKeys.length === 0 ||
      input.appKeys.some((k) => typeof k !== 'string' || k.length === 0)
    ) {
      violations.push({ field: 'appKeys', message: 'appKeys 必须是非空字符串数组' })
    }
  }
  if (input.trafficMb !== undefined && !isNonNegativeInt(input.trafficMb)) {
    violations.push({ field: 'trafficMb', message: 'trafficMb 必须是非负整数' })
  }
  return violations
}
