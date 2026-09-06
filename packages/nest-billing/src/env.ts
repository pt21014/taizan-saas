/**
 * 计费相关的 env 片段，供项目用 `defineEnvSchema(BASE_ENV_SCHEMA, { ...BILLING_ENV_SHAPE })` 合并。
 *
 * ## 它和 `BASE_ENV_SHAPE.BILLING_ENFORCE` 是什么关系
 *
 * `@taizan/nest-core` 的基础 schema 里**已经有** `BILLING_ENFORCE` 了
 * （`assertNoDevCodeInProd` / `warnIfBillingNotEnforcedInProd` 要读它，那两个函数
 * 在计费包装不装都得能跑）。这里这一份是**同形状的独立副本**，用途是：
 *
 * - 不用基础 schema 的项目（只装了 `@taizan/nest-billing` 的小服务）也能拿到校验；
 * - 独立脚本 / worker 进程只想校验计费这一段；
 * - 让「这个包读哪些环境变量」在包内部就答得上来，不必翻到 nest-core 去找。
 *
 * 合并时后写的覆盖先写的，两份形状一致所以覆盖无害；
 * `env.spec.ts` 断言两者对同一批输入给出同样的结果，防止哪天有一份被改跑偏。
 * **本包不修改 nest-core**——那是 T0-6 的地盘。
 *
 * @packageDocumentation
 */

import { z } from 'zod'

/**
 * 与 nest-core `env.schema.ts` 里的 `envBoolean` 同款。
 *
 * 关键是拼错时**不静默变 false**：`BILLING_ENFORCE=ture` 悄悄变成关闭，
 * 是「上线了以为在收钱其实没收」的那种 bug，必须在启动时炸出来。
 */
function envBoolean(
  defaultValue: boolean,
): z.ZodDefault<z.ZodEffects<z.ZodBoolean, boolean, unknown>> {
  return z
    .preprocess((raw) => {
      if (raw === undefined || raw === '') return defaultValue
      if (typeof raw === 'boolean') return raw
      const s = String(raw).trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(s)) return true
      if (['0', 'false', 'no', 'off'].includes(s)) return false
      return raw
    }, z.boolean())
    .default(defaultValue)
}

/** 计费 env 片段。 */
export const BILLING_ENV_SHAPE = {
  BILLING_ENFORCE: envBoolean(false).describe(
    '计费闸门总开关。false 时到期租户仍可写（只记 reason 并打 warn），' +
      '打开之前先跑 deploy/checks/billing-check.sh 看谁会被锁',
  ),
} as const

/** 单独用时的 schema。 */
export const BILLING_ENV_SCHEMA = z.object(BILLING_ENV_SHAPE)

/** 校验通过后的类型。 */
export type BillingEnv = z.infer<typeof BILLING_ENV_SCHEMA>
