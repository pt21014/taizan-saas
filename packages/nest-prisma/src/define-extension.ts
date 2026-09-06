/**
 * `Prisma.defineExtension` 的类型适配层。
 *
 * ## 为什么需要这一层
 *
 * Prisma 的 query 钩子签名里，`query(args)` 的参数类型是 `JsArgs`——一个由
 * `prisma generate` 产物带进来的内部类型。本包是**框架包**，编译时所在的仓库没有生成
 * 产物，只能用 `@prisma/client/extension` 这个「给库作者的」入口，那里的类型是
 * 半 `any` 的骨架，`JsArgs` 与我们自己的 `Record<string, unknown>` 在
 * `strictFunctionTypes` 下互不兼容（函数参数是逆变的）。
 *
 * 两种收口方式：整个扩展体都写成 `any`，或者把不兼容集中到**一处**显式转换。选后者：
 * 三个扩展的实现体因此保持完全类型安全，`any` 一个都没有；真正「骗过编译器」的只有
 * 下面这两个函数里的 `as unknown as`，而它们除了转类型什么都不做。
 *
 * @packageDocumentation
 */

import { Prisma } from '@prisma/client/extension'
import type { PrismaClientLike, QueryHook } from './types'

/** `Prisma.defineExtension` 的入参类型（联合类型，含对象形态与函数形态）。 */
type DefineExtensionArg = Parameters<typeof Prisma.defineExtension>[0]

/** `Prisma.defineExtension` 的返回类型：一个 `(client) => 扩展后的 client`。 */
export type PrismaExtension = ReturnType<typeof Prisma.defineExtension>

/**
 * 用一个 `$allModels.$allOperations` 钩子定义扩展（对象形态）。
 *
 * @param name - 扩展名，出错时会出现在 Prisma 的报错里
 * @param hook - 钩子实现
 */
export function defineQueryExtension(name: string, hook: QueryHook): PrismaExtension {
  const definition = { name, query: { $allModels: { $allOperations: hook } } }
  return Prisma.defineExtension(definition as unknown as DefineExtensionArg)
}

/**
 * 定义一个需要「回头调用自己被叠加到的那个客户端」的扩展（函数形态）。
 *
 * ## ⚠️ 不要拿它做写路径的操作改写
 *
 * `build(client)` 里的 `client` 是在 **`$extends` 那一刻**捕获的引用，而
 * `$transaction()` 会另建一个绑在事务连接上的客户端，**并不会重新调用这个工厂**。
 * 所以任何「回头往 `client` 再发一次请求」的改写，在事务里都会发到**事务之外**——
 * 事务回滚了，那次改写却留下了。
 *
 * 软删曾经就是这么写的（`delete` → 回头发 `update`），T0-8 的隔离 e2e 用例⑪
 * 在真库上把它抓了出来：事务回滚后商品仍然是软删状态。修法见
 * `extensions/soft-delete.ts` 的文件头（改用 model 组件 + `Prisma.getExtensionContext`）。
 *
 * 本函数保留下来只服务**读路径**的场景（拿客户端做旁路查询而不改写主操作）。
 * 写路径请用 {@link defineModelAndQueryExtension}。
 *
 * @param name - 扩展名
 * @param build - 拿到被叠加的客户端后，造出钩子
 */
export function defineClientBoundQueryExtension(
  name: string,
  build: (client: PrismaClientLike) => QueryHook,
): PrismaExtension {
  const factory = (client: PrismaClientLike): unknown => {
    const definition = { name, query: { $allModels: { $allOperations: build(client) } } }
    return (client as { $extends(extension: unknown): unknown }).$extends(definition)
  }
  return Prisma.defineExtension(factory as unknown as DefineExtensionArg)
}

/**
 * 模型委托上某个操作的覆盖实现。
 *
 * `this` 是 Prisma 的**扩展上下文**——用 `Prisma.getExtensionContext(this)` 取出来之后
 * 它就是「当前这个模型委托」，**在事务里就是事务的那个委托**。这正是它比
 * {@link defineClientBoundQueryExtension} 强的地方：改写发出去的请求跟着事务走。
 */
export type ModelOverride = (this: unknown, args?: Record<string, unknown>) => Promise<unknown>

/**
 * 定义一个同时带 **model 组件**（覆盖具体操作）与 **query 组件**（拦截所有操作）的扩展。
 *
 * 两个组件的分工是有讲究的：
 * - **model 组件**能换操作（`delete` → `update`），而且 `Prisma.getExtensionContext(this)`
 *   拿到的委托是**事务感知**的；代价是它替换掉了委托上的那个方法，
 *   本扩展**自己的** query 钩子看不到这次调用（外层扩展的 model 覆盖也看不到）。
 * - **query 组件**看得到每一次调用，但改不了操作名。
 *
 * 所以规则是：**要换操作就用 model，只改 args 就用 query**。
 *
 * @param name - 扩展名
 * @param modelOverrides - 操作名 → 覆盖实现（挂在 `$allModels` 上）
 * @param queryHook - 可选的 `$allOperations` 钩子
 */
export function defineModelAndQueryExtension(
  name: string,
  modelOverrides: Readonly<Record<string, ModelOverride>>,
  queryHook?: QueryHook,
): PrismaExtension {
  const definition: Record<string, unknown> = {
    name,
    model: { $allModels: { ...modelOverrides } },
  }
  if (queryHook) {
    definition.query = { $allModels: { $allOperations: queryHook } }
  }
  return Prisma.defineExtension(definition as unknown as DefineExtensionArg)
}

/**
 * 从 `this` 拿出当前模型委托（事务里就是事务的那个）。
 *
 * `Prisma.getExtensionContext` 在运行时就是一个恒等函数，值全在类型上；
 * 包一层是为了把「委托上有 `$name` / `$parent`」这两个约定写进类型，
 * 并且让「哪里依赖了扩展上下文」在源码里可 grep。
 *
 * @param self - 覆盖实现里的 `this`
 */
export function extensionContext(self: unknown): ModelExtensionContext {
  return Prisma.getExtensionContext(self as never) as unknown as ModelExtensionContext
}

/** 模型覆盖实现里能拿到的上下文。 */
export interface ModelExtensionContext {
  /** 当前模型名（PascalCase），例如 `Goods`。 */
  readonly $name?: string
  /**
   * 本扩展被叠加**之前**的那个客户端。
   *
   * 需要「原样执行被覆盖掉的那个操作」时走它——不走它就是无限递归。
   * 它同样是事务感知的。
   */
  readonly $parent?: Record<string, Record<string, (args?: unknown) => Promise<unknown>>>
  /** 委托上的其它操作（走完整的 query 钩子链）。 */
  readonly [operation: string]: unknown
}
