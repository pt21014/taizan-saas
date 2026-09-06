/**
 * 执行层用到的最小结构化类型。
 *
 * 为什么不直接 `import type { PrismaClient } from '@prisma/client'`：本包是**框架包**，
 * 编译时所在的仓库里根本没有跑过 `prisma generate`，`@prisma/client` 的类型入口
 * （`.prisma/client/default`）不存在，直接 import 会让 `tsc --noEmit` 直接红。
 * 官方给库作者准备的入口是 `@prisma/client/extension`——它只导出 `Prisma.defineExtension`
 * 与一个 `any` 形状的 `PrismaClient`，不需要生成产物。
 *
 * 所以本包对「客户端」只做结构化约束：能按 camelCase 模型名取到一个委托对象，委托对象上
 * 有若干 `(args) => Promise<unknown>` 方法。业务侧拿到的仍是完整类型的 Prisma 客户端，
 * 类型收窄发生在 `PrismaService` 的泛型参数上。
 *
 * @packageDocumentation
 */

/** Prisma 调用的 `args`：一个普通对象。 */
export type PrismaArgs = Record<string, unknown>

/** 模型委托（`prisma.goods`）上的一个操作方法。 */
export type DelegateOperation = (args?: PrismaArgs) => Promise<unknown>

/**
 * 模型委托（`prisma.goods`）。
 *
 * 既穷举了 Prisma 6 的全部模型操作，又留了索引签名兜底。两者都要：
 * - 具名属性让 `delegate.findMany(...)` 在 `noUncheckedIndexedAccess` 下不必写 `?.`；
 * - 索引签名让「Prisma 将来新增的操作」「测试里故意传的未知操作名」仍然表达得出来
 *   （它们经过索引访问，类型是 `DelegateOperation | undefined`，正好逼调用方处理）。
 */
export interface ModelDelegate {
  findUnique: DelegateOperation
  findUniqueOrThrow: DelegateOperation
  findFirst: DelegateOperation
  findFirstOrThrow: DelegateOperation
  findMany: DelegateOperation
  count: DelegateOperation
  aggregate: DelegateOperation
  groupBy: DelegateOperation
  create: DelegateOperation
  createMany: DelegateOperation
  createManyAndReturn: DelegateOperation
  update: DelegateOperation
  updateMany: DelegateOperation
  updateManyAndReturn: DelegateOperation
  upsert: DelegateOperation
  delete: DelegateOperation
  deleteMany: DelegateOperation
  /** Prisma 将来新增的操作，或测试里故意用的未知操作名。 */
  [operation: string]: DelegateOperation
}

/**
 * 「长得像 Prisma 客户端」的最小约束：一个对象。
 *
 * 刻意不写成 `Record<string, ModelDelegate>`——真实 PrismaClient 上还有 `$transaction`
 * 之类的非委托属性，写成索引签名反而会骗过类型检查。取委托一律走 {@link modelDelegateOf}。
 */
export type PrismaClientLike = object

/** 一次 Prisma 查询在扩展里被拦截到的形状（`Prisma.defineExtension` 的 query 回调参数）。 */
export interface QueryHookParams {
  /** Prisma 模型名（PascalCase），例如 `Goods`。 */
  model: string
  /** Prisma 操作名，例如 `findMany`。 */
  operation: string
  /** 上一层扩展（或调用方）传下来的 args。 */
  args: unknown
  /** 继续往内层执行。**必须**调用它，否则查询不会发生。 */
  query: (args: unknown) => Promise<unknown>
}

/** 一个 `$allOperations` 查询钩子。 */
export type QueryHook = (params: QueryHookParams) => Promise<unknown>

/** 判断是不是普通对象（不是 null、不是数组）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 `args` 规整成对象副本；`undefined` / `null` 视作 `{}`。 */
export function toArgsObject(args: unknown, at: string): PrismaArgs {
  if (args === undefined || args === null) return {}
  if (!isPlainObject(args)) {
    throw new TypeError(`[@taizan/nest-prisma] ${at} 的 args 必须是对象，收到 ${typeof args}。`)
  }
  return { ...args }
}

/**
 * 从客户端上取出某个模型的委托对象。
 *
 * @param client - 任意 Prisma 客户端（含扩展后的）
 * @param clientKey - camelCase 的模型属性名，用 `modelToClientKey(model)` 得到
 * @throws 取不到委托时抛——比让 `undefined.findUnique` 报 `TypeError` 好查
 */
export function modelDelegateOf(client: PrismaClientLike, clientKey: string): ModelDelegate {
  const delegate = (client as Record<string, unknown>)[clientKey]
  if (typeof delegate !== 'object' || delegate === null) {
    throw new TypeError(
      `[@taizan/nest-prisma] 客户端上没有模型委托 "${clientKey}"。` +
        `是不是模型名写错了，或者传进来的不是 Prisma 客户端？`,
    )
  }
  return delegate as ModelDelegate
}

/**
 * 调用委托上的某个操作。
 *
 * @throws 操作不存在时抛——同样是为了「响亮地失败」。
 */
export async function callOperation(
  client: PrismaClientLike,
  clientKey: string,
  operation: string,
  args: PrismaArgs,
): Promise<unknown> {
  const delegate = modelDelegateOf(client, clientKey)
  const fn = delegate[operation]
  if (typeof fn !== 'function') {
    throw new TypeError(`[@taizan/nest-prisma] 模型委托 "${clientKey}" 上没有操作 "${operation}"。`)
  }
  return fn.call(delegate, args)
}
