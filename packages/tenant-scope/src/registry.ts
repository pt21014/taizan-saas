/**
 * 租户模型注册机。
 *
 * knowledge 那版把 110 个业务表名硬编码在 `tenant-scope.ts` 里，框架化之后这条路走不通：
 * 框架不认识业务表。改成「框架给基础表，项目自己 register 业务表，启动期 freeze」。
 *
 * 冻结这一步很关键：注册表决定了哪些表受隔离约束，运行期还能改就等于隔离范围能被运行期
 * 代码悄悄缩小。所以 `freeze()` 之后再 `register()` 直接抛错。
 */

import { TenantScopeError } from './errors'

/** {@link createTenantModelRegistry} 的返回值。 */
export interface TenantModelRegistry {
  /**
   * 登记一批租户域模型。只能在 freeze 之前调用。
   *
   * @param models - Prisma 模型名数组，例如 `['Goods', 'GoodsSku']`
   * @throws {@link TenantScopeError} `REGISTRY_FROZEN` / `DUPLICATE_REGISTRATION` /
   *   `INVALID_MODEL_NAME`
   */
  register(models: readonly string[]): void
  /**
   * 冻结注册表。幂等：重复调用返回同样的内容，不报错。
   *
   * @returns 当前全部租户域模型名的只读集合（每次返回独立副本，改它不影响注册表）
   */
  freeze(): ReadonlySet<string>
  /**
   * 当前全部租户域模型名，按字典序排序。用于 `verifySchema` 比对与错误提示。
   *
   * @returns 排序后的模型名数组
   */
  snapshot(): string[]
  /**
   * 是否为租户域模型。签名与 `Set.has` 一致，可直接当 `planTenantScope` 的 `registered`。
   *
   * @param model - Prisma 模型名
   * @returns 是否受租户隔离约束
   */
  has(model: string): boolean
  /** 注册表是否已冻结。 */
  readonly frozen: boolean
}

function assertValidModelName(model: unknown): asserts model is string {
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new TenantScopeError(
      'INVALID_MODEL_NAME',
      `租户模型名必须是非空字符串，收到 ${model === null ? 'null' : typeof model}。`,
    )
  }
}

/**
 * 创建一个租户模型注册表。
 *
 * @param base - 框架内置的基础租户域模型（`@taizan/prisma-base` 提供），可省略
 * @returns 注册表实例，见 {@link TenantModelRegistry}
 * @throws {@link TenantScopeError} `DUPLICATE_REGISTRATION`（`base` 自身有重复项时）
 *
 * @example
 * ```ts
 * // apps/api/src/tenancy/tenant-models.ts
 * export const registry = createTenantModelRegistry(BASE_TENANT_MODELS)
 * registry.register(['Goods', 'GoodsSku'])
 * export const TENANT_MODELS = registry.freeze()
 * ```
 */
export function createTenantModelRegistry(base: readonly string[] = []): TenantModelRegistry {
  const models = new Set<string>()
  let frozen = false

  const add = (model: string, origin: string): void => {
    assertValidModelName(model)
    if (models.has(model)) {
      throw new TenantScopeError(
        'DUPLICATE_REGISTRATION',
        `租户模型 ${model} 被重复登记（${origin}）。重复通常意味着两处清单打架，` +
          `请确认它到底归框架基础表还是业务表。`,
        { model },
      )
    }
    models.add(model)
  }

  for (const model of base) add(model, 'base')

  return {
    register(next: readonly string[]): void {
      if (frozen) {
        throw new TenantScopeError(
          'REGISTRY_FROZEN',
          `租户模型注册表已冻结，不能再登记 ${next.join(', ') || '（空）'}。` +
            `所有 register() 必须发生在启动期、freeze() 之前。`,
        )
      }
      for (const model of next) add(model, 'register')
    },
    freeze(): ReadonlySet<string> {
      frozen = true
      return new Set(models)
    },
    snapshot(): string[] {
      return [...models].sort()
    },
    has(model: string): boolean {
      return models.has(model)
    },
    get frozen(): boolean {
      return frozen
    },
  }
}
