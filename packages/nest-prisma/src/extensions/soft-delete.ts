/**
 * 软删扩展：**读过滤 + 写改写**，两件事一起做。
 *
 * ## 反面教材（xiaodian `soft-delete.extension.ts`）
 *
 * 老项目那版只做读过滤，`delete` 原样落到数据库上——于是「软删」在读路径上是软的、
 * 在写路径上是硬的：列表看不见的记录其实已经被物理删除了，回收站、审计追溯、外键
 * 关联全都对不上。而且它是**就地改 `args.where`**（`a.where = { ...where, deleted_at: null }`），
 * 调用方传的 `where` 对象被扩展偷偷改掉，同一个对象复用第二次时行为就变了。
 *
 * 本文件三点不同：
 * - 写路径一起改：`delete` → `update{ deletedAt }`、`deleteMany` → `updateMany`；
 * - 不改调用方对象，一律返回副本；
 * - 物理删除只有一个入口 {@link hardDelete}，而且只能拿**未叠加租户扩展的原始客户端**调。
 *
 * ## 与租户扩展的叠加顺序（重要）
 *
 * Prisma 的 query 钩子按 `$extends` 的**先后顺序**组合，先加的先执行（最外层）。
 * 正确顺序是 `tenant → softDelete → ulid`：
 *
 * ```
 * base.$extends(tenant).$extends(softDelete).$extends(ulid)
 *      ↑ 最外层，先跑        ↑ 中间             ↑ 最内层，最后跑
 * ```
 *
 * 租户扩展必须在外层，理由有两条：
 * 1. 软删会把 `delete` 改写成 `update`。若软删在外层，租户扩展看到的操作名就不是调用方
 *    真正发起的那个，`upsert`/`delete` 的分支判断会失真。
 * 2. 租户条件由 `plan.args` 一次性算好；软删只是在它外面再包一层 `AND`，包不进去也覆盖
 *    不掉。最终 `where` 形如
 *    `{ AND: [{ deletedAt: null }, { AND: [{ tenantId: 't1' }, 调用方的 where] }] }`
 *    ——两个条件同时成立，谁都盖不住谁。`stacking.spec.ts` 里有这条断言。
 *
 * ## `delete` 改写为什么必须走 **model 组件**（而不是 query 钩子）
 *
 * Prisma 的 query 扩展**不能改操作名**（`query()` 绑死在原操作上），所以 `delete`
 * 只能靠「重新发一次 `update`」来实现。问题是**往哪个客户端发**。
 *
 * 第一版用的是 `defineClientBoundQueryExtension`：在 `$extends` 那一刻捕获客户端引用，
 * 之后回头往它发 `update`。**这在事务里是错的**——`$transaction()` 会另建一个绑在
 * 事务连接上的客户端，而且**不会重新调用那个工厂**，于是闭包里那个引用仍然指向
 * 事务之外的客户端。后果：
 *
 * ```ts
 * await prisma.$transaction(async (tx) => {
 *   await tx.goods.delete({ where: { id } })   // 软删发到了事务外
 *   throw new Error('业务校验没过')             // 事务回滚
 * })
 * // → 事务回滚了，商品却已经被软删。数据不一致，而且不报错。
 * ```
 *
 * T0-8 的隔离 e2e 用例⑪在真库上抓到了这个（T0-6 当时只是标注了隐患）。
 *
 * 修法：把 `delete` / `deleteMany` 换成 **model 组件**的覆盖实现，用
 * `Prisma.getExtensionContext(this)` 取当前模型委托——**它在事务里就是事务的那个委托**，
 * 于是改写出来的 `update` 跟着事务走。读路径的过滤仍然留在 query 钩子里（那部分
 * 只改 args，不换操作，没有这个问题）。
 *
 * ## 换成 model 组件之后，隔离还在吗
 *
 * 在。`ctx.update(...)` 走的是**完整的 query 钩子链**，租户扩展照样看得到这次 `update`，
 * 并按 `verifyOwnerThenExecute` 先验归属再执行。区别只是租户扩展现在看到的操作名是
 * `update` 而不是先 `delete` 后 `update`——少一次探针，安全性不变。
 *
 * 不在软删名单里的模型走 `ctx.$parent`（本扩展被叠加**之前**的那个客户端，同样事务感知），
 * 于是它们的 `delete` 原样落库，且仍然经过租户扩展。
 *
 * @packageDocumentation
 */

import { modelToClientKey } from '@taizan/tenant-scope'
import {
  defineModelAndQueryExtension,
  extensionContext,
  type ModelExtensionContext,
  type PrismaExtension,
} from '../define-extension'
import {
  callOperation,
  isPlainObject,
  toArgsObject,
  type PrismaArgs,
  type PrismaClientLike,
  type QueryHookParams,
} from '../types'

/**
 * 调用方用来「连已软删的一起查」的自定义 arg。
 *
 * 它**不是** Prisma 的参数，执行前必须剥掉，否则 Prisma 会报未知参数。
 */
export const WITH_DELETED_ARG = 'withDeleted'

/**
 * 会被自动补 `deletedAt: null` 的读操作。
 *
 * `findUnique` / `findUniqueOrThrow` 单独处理（见 {@link applyReadFilter}），
 * 它们的 `where` 形状不接受 `AND` 包裹。
 */
const AND_FILTERED_READ_OPERATIONS: readonly string[] = [
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]

/** 按唯一键定位的读操作：`where` 里只能平铺加条件。 */
const UNIQUE_READ_OPERATIONS: readonly string[] = ['findUnique', 'findUniqueOrThrow']

const AND_FILTERED = new Set(AND_FILTERED_READ_OPERATIONS)
const UNIQUE_READ = new Set(UNIQUE_READ_OPERATIONS)

/** {@link createSoftDeleteExtension} 的选项。 */
export interface SoftDeleteExtensionOptions {
  /** 软删列名，默认 `deletedAt`（蓝图 §3.1 的约定，正常不要改）。 */
  field?: string
  /** 取「现在」。测试里注入固定时间，生产用默认的 `() => new Date()`。 */
  now?: () => Date
}

/**
 * 给读操作补上「未删除」条件。
 *
 * `findUnique*` 用平铺合并而不是 `AND` 包裹：Prisma 的唯一键 `where` 是
 * `XxxWhereUniqueInput`，从 v5 起允许在唯一键旁边平铺非唯一字段做过滤
 * （extendedWhereUnique），但**不接受**顶层 `AND`。
 *
 * 平铺合并意味着调用方显式写 `where: { id, deletedAt: { not: null } }` 能盖过默认值——
 * 这是**故意**的：软删是便利过滤，不是安全边界。安全边界是租户扩展，那里用的是
 * 覆盖不掉的 `AND` 包裹。想连软删的一起查，正规写法是 `withDeleted: true`。
 */
function applyReadFilter(operation: string, args: PrismaArgs, field: string): PrismaArgs {
  if (UNIQUE_READ.has(operation)) {
    const where = isPlainObject(args.where) ? args.where : {}
    if (field in where) return args
    return { ...args, where: { ...where, [field]: null } }
  }
  return { ...args, where: { AND: [{ [field]: null }, args.where ?? {}] } }
}

/**
 * 创建软删扩展。
 *
 * @param models - 有 `deletedAt` 列的模型名集合（PascalCase）。不在集合里的模型完全不碰。
 * @param options - 见 {@link SoftDeleteExtensionOptions}
 * @returns 可以直接喂给 `client.$extends(...)` 的扩展
 *
 * @example
 * ```ts
 * const client = base
 *   .$extends(createTenantExtension(deps))          // 必须在外层
 *   .$extends(createSoftDeleteExtension(new Set(['Goods'])))
 *
 * await client.goods.findMany()                     // where 自动带 deletedAt: null
 * await client.goods.findMany({ withDeleted: true }) // 连已软删的一起查
 * await client.goods.delete({ where: { id } })      // 实际发出的是 update{ deletedAt: now }
 * ```
 */
export function createSoftDeleteExtension(
  models: ReadonlySet<string>,
  options: SoftDeleteExtensionOptions = {},
): PrismaExtension {
  const field = options.field ?? 'deletedAt'
  const now = options.now ?? ((): Date => new Date())

  /** 取当前模型名。拿不到就是上下文坏了——响亮地失败，别静默跳过软删。 */
  const modelOf = (ctx: ModelExtensionContext, operation: string): string => {
    const name = ctx.$name
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(
        `[@taizan/nest-prisma] 软删扩展在 ${operation} 上拿不到 $name（扩展上下文不对）。`,
      )
    }
    return name
  }

  /** 原样执行被覆盖掉的操作：走 `$parent`（本扩展叠加**之前**的客户端，事务感知）。 */
  const passthrough = (
    ctx: ModelExtensionContext,
    model: string,
    operation: string,
    args: PrismaArgs,
  ): Promise<unknown> => {
    const parent = ctx.$parent
    if (!parent) {
      throw new TypeError(
        `[@taizan/nest-prisma] 软删扩展在 ${model}.${operation} 上拿不到 $parent，无法透传。`,
      )
    }
    return callOperation(
      parent as unknown as PrismaClientLike,
      modelToClientKey(model),
      operation,
      args,
    )
  }

  return defineModelAndQueryExtension(
    'taizan-soft-delete',
    {
      /** `delete` → `update{ deletedAt: now }`，发在**当前**（可能是事务的）委托上。 */
      async delete(this: unknown, args?: PrismaArgs): Promise<unknown> {
        const ctx = extensionContext(this)
        const model = modelOf(ctx, 'delete')
        const next = toArgsObject(args, `${model}.delete`)
        if (WITH_DELETED_ARG in next) delete next[WITH_DELETED_ARG]

        if (!models.has(model)) return passthrough(ctx, model, 'delete', next)

        const { where, ...rest } = next
        // `ctx.update` 走完整的 query 钩子链——租户扩展照样会先验归属再执行。
        return invokeOnContext(ctx, 'update', { ...rest, where, data: { [field]: now() } })
      },

      /** `deleteMany` → `updateMany`，同上。 */
      async deleteMany(this: unknown, args?: PrismaArgs): Promise<unknown> {
        const ctx = extensionContext(this)
        const model = modelOf(ctx, 'deleteMany')
        const next = toArgsObject(args, `${model}.deleteMany`)
        if (WITH_DELETED_ARG in next) delete next[WITH_DELETED_ARG]

        if (!models.has(model)) return passthrough(ctx, model, 'deleteMany', next)

        const { where, ...rest } = next
        return invokeOnContext(ctx, 'updateMany', {
          ...rest,
          // 已经软删过的不再重新盖时间戳，count 也才是「这次真的删了几条」。
          where: { AND: [{ [field]: null }, where ?? {}] },
          data: { [field]: now() },
        })
      },
    },
    async ({ model, operation, args, query }: QueryHookParams): Promise<unknown> => {
      const next = toArgsObject(args, `${model}.${operation}`)

      // withDeleted 是本扩展的自定义 arg，任何情况下都必须在下发前剥掉。
      const withDeleted = next[WITH_DELETED_ARG] === true
      if (WITH_DELETED_ARG in next) delete next[WITH_DELETED_ARG]

      if (!models.has(model)) return query(next)
      if (withDeleted) return query(next)

      if (AND_FILTERED.has(operation) || UNIQUE_READ.has(operation)) {
        return query(applyReadFilter(operation, next, field))
      }

      return query(next)
    },
  )
}

/** 在扩展上下文（= 当前模型委托）上调一个操作。 */
function invokeOnContext(
  ctx: ModelExtensionContext,
  operation: string,
  args: PrismaArgs,
): Promise<unknown> {
  const fn = (ctx as unknown as Record<string, unknown>)[operation]
  if (typeof fn !== 'function') {
    throw new TypeError(
      `[@taizan/nest-prisma] 扩展上下文上没有操作 "${operation}"（拿到的不是模型委托？）。`,
    )
  }
  return (fn as (a: PrismaArgs) => Promise<unknown>).call(ctx, args)
}

/**
 * 物理删除逃生口。
 *
 * **只允许拿未叠加租户扩展的原始客户端调**（`RawPrismaService` / `PrismaService` 的
 * 内部 base client）。所以它是个必须显式传 client 的函数，而不是挂在 `prisma.tenant`
 * 上的方法——业务代码想物理删，就必须先把 `RawPrismaService` 注进来，
 * 于是它会出现在 spec 3（`raw-usage.spec.ts`）的扫描结果里，跑不掉。
 *
 * 合法用途只有两类：合规要求的「彻底删除个人数据」，以及测试夹具清理。
 *
 * @param base - 原始 Prisma 客户端（没有软删扩展，否则会被改写回 update）
 * @param model - Prisma 模型名（PascalCase）
 * @param args - Prisma `delete` 的原始 args
 */
export async function hardDelete(
  base: PrismaClientLike,
  model: string,
  args: PrismaArgs,
): Promise<unknown> {
  return callOperation(base, modelToClientKey(model), 'delete', args)
}

/**
 * 物理批量删除逃生口。约束同 {@link hardDelete}。
 */
export async function hardDeleteMany(
  base: PrismaClientLike,
  model: string,
  args: PrismaArgs,
): Promise<unknown> {
  return callOperation(base, modelToClientKey(model), 'deleteMany', args)
}
