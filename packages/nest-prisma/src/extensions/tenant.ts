/**
 * 租户隔离的**执行层**：把 `@taizan/tenant-scope` 算出来的 {@link ScopePlan} 照做一遍。
 *
 * ## 这个文件唯一的职责
 *
 * 「查询该怎么隔离」的规则**一条都不在这里**。规则全部在 `@taizan/tenant-scope/plan.ts`
 * 的纯函数里（四条不可退让见那个文件的文件头），本文件只做三件事：
 *
 * 1. 从上下文取 `tenantId`，原样交给 {@link planTenantScope}；
 * 2. 按 `plan.action` 分四支执行；
 * 3. 需要校验归属时调 {@link assertResultOwner}。
 *
 * 为什么要卡这么死：隔离规则一旦出现「决策层一份、执行层一份」两个副本，两份就会各自
 * 演化，某天只改了一份，租户之间就串数据了——而串数据不会报错。`no-bypass.spec.ts`
 * 会扫描本包源码，断言除本文件外没有任何地方自己拼 `tenantId` 条件、本文件里不出现
 * `AND:`（`where` 的 `AND` 包裹只能来自 `plan.args`）。
 *
 * ## 无上下文一律抛，绝不放行
 *
 * `getTenantId()` 取不到就传空串给决策函数，由它抛 `NO_CONTEXT`。执行层**不能**
 * 自己写 `if (!tenantId) return query(args)`——那正是老项目 xiaodian 的洞：没登录 /
 * 没解析出租户时退化成查全表。
 *
 * ## 叠加顺序
 *
 * 本扩展必须是**最外层**（第一个 `$extends` 的）。Prisma 的 query 钩子按 `$extends`
 * 的先后顺序组合，**先加的先执行**（最外层）。放最外层的理由：软删扩展会把 `delete`
 * 改写成 `update`，若软删在外层，租户扩展看到的就不是调用方真正发起的操作了；租户
 * 判断必须基于原始操作。见 `soft-delete.ts` 的文件头与 `stacking.spec.ts`。
 *
 * @packageDocumentation
 */

import { defineQueryExtension, type PrismaExtension } from '../define-extension'
import {
  assertResultOwner,
  modelToClientKey,
  planTenantScope,
  type NestedCreateStrategy,
  type ScopePlan,
  type TenantModelLookup,
} from '@taizan/tenant-scope'
import { callOperation, isPlainObject, type PrismaClientLike, type QueryHookParams } from '../types'

/** {@link createTenantExtension} 的依赖。 */
export interface TenantExtensionDeps {
  /**
   * 取当前租户 id。**取不到就返回 `undefined`**，不要在这里兜底成某个默认租户，
   * 也不要自己抛——是不是该抛由决策函数按「模型是否受隔离约束」决定。
   *
   * 典型实现：`() => currentContext()?.tenantId`（`@taizan/nest-core`）。
   */
  getTenantId(): string | undefined

  /**
   * 受隔离约束的模型集合。`ReadonlySet<string>` 或 `createTenantModelRegistry().freeze()`
   * 的返回值都满足。
   */
  registered: TenantModelLookup

  /**
   * 「先验归属」用的探针客户端。
   *
   * **必须传未叠加任何扩展的原始客户端**：探针要看到全部记录，包括已软删的。
   * 如果传一个带软删读过滤的句柄，更新一条已软删记录时探针会查不到 → 归属校验被跳过。
   * 也不能传本扩展自己的产物——那会无限递归。
   */
  raw: PrismaClientLike

  /** 关系字段名 → 目标模型名，用于一层嵌套 `create` 的注入判断。透传给决策函数。 */
  nestedModels?: Readonly<Record<string, string>>

  /** 嵌套 `create` 的注入策略，默认 `'mapped'`。透传给决策函数。 */
  nestedCreate?: NestedCreateStrategy

  /** 遇到未登记模型的行为，默认 `'passthrough'`。测试环境建议设 `'throw'`。 */
  onUnregistered?: 'passthrough' | 'throw'
}

/**
 * 先按唯一键查一次归属，确认记录属于当前租户后再放行。
 *
 * 探针查不到记录时**不拦**：可能是记录本来就不存在（交给 Prisma 报 `P2025`），
 * 也可能是 `upsert` 要走 create 分支。归属校验只负责挡「存在但属于别人」。
 */
async function verifyOwner(
  raw: PrismaClientLike,
  model: string,
  operation: string,
  tenantId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const where = args.where
  if (!isPlainObject(where)) return

  const record = await callOperation(raw, modelToClientKey(model), 'findUnique', {
    where,
    // 归属校验只需要这一个字段；这里是本包唯一允许出现 `tenantId` 字面量的地方，
    // 而且它是 `select`（读），不是 `where`（过滤条件）。
    select: { tenantId: true },
  })

  // 复用决策层的校验器，执行层不自己比对字符串。存在且属于别人 → 抛 FOREIGN_RESULT。
  assertResultOwner({ model, operation, tenantId, record, throwWhenForeign: true })
}

/**
 * 创建租户隔离扩展。
 *
 * @param deps - 见 {@link TenantExtensionDeps}
 * @returns 可以直接喂给 `client.$extends(...)` 的扩展
 * @throws 运行时可能抛 `TenantScopeError`（`NO_CONTEXT` / `UNKNOWN_OPERATION` /
 *   `TENANT_ID_CONFLICT` / `FOREIGN_RESULT` / `MODEL_NOT_REGISTERED` / `INVALID_ARGUMENT`），
 *   用 `isTenantScopeError()` 判别。
 *
 * @example
 * ```ts
 * const tenant = base
 *   .$extends(createTenantExtension({ getTenantId, registered, raw: base })) // 最外层
 *   .$extends(createSoftDeleteExtension(softDeleteModels))
 *   .$extends(createUlidExtension())
 * ```
 */
export function createTenantExtension(deps: TenantExtensionDeps): PrismaExtension {
  const { getTenantId, registered, raw } = deps

  return defineQueryExtension(
    'taizan-tenant-scope',
    async ({ model, operation, args, query }: QueryHookParams): Promise<unknown> => {
      // 取不到就是空串：由决策函数决定抛 NO_CONTEXT 还是（非租户域模型）放行。
      const tenantId = getTenantId() ?? ''

      const plan: ScopePlan = planTenantScope({
        model,
        operation,
        args,
        tenantId,
        registered,
        nestedModels: deps.nestedModels,
        nestedCreate: deps.nestedCreate,
        onUnregistered: deps.onUnregistered,
      })

      switch (plan.action) {
        case 'passthrough':
          return query(args)

        case 'execute':
          return query(plan.args)

        case 'checkResultOwner': {
          const record = await query(plan.args)
          return assertResultOwner({
            model,
            operation,
            tenantId,
            record,
            throwWhenForeign: plan.throwWhenForeign,
          })
        }

        case 'verifyOwnerThenExecute': {
          await verifyOwner(raw, model, operation, tenantId, plan.args)
          return query(plan.args)
        }

        default: {
          // 决策层新增了一种 action 而执行层没跟上 —— 编译期就该红。
          const unreachable: never = plan
          throw new Error(`[@taizan/nest-prisma] 未知的隔离计划：${JSON.stringify(unreachable)}`)
        }
      }
    },
  )
}
