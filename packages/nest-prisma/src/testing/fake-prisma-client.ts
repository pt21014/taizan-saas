/**
 * `FakePrismaClient`：手写的最小 Prisma 客户端替身，用来在**不连库**的前提下驱动本包的
 * 三个扩展。
 *
 * ## 为什么不用 mock 库 / 不连真库
 *
 * 本包要证明的命题是「隔离条件确实被拼进了发给 Prisma 的 args」。连真库测的是
 * 「查出来的数据对不对」——同样一条 SQL，租户列刚好为空时也能过。直接把
 * `(model, operation, args)` 记下来断言，才能证明**改写**这件事本身发生了。
 * 真库上的隔离验收在 `apps/api/test/tenant-isolation.e2e-spec.ts`（T0-8）。
 *
 * ## 复刻了 Prisma 的哪些语义（这是它唯一的价值）
 *
 * - `$extends(obj)` 追加一个 `query.$allModels.$allOperations` 钩子；
 * - `$extends(fn)` 调用 `fn(当前客户端)`，与 `Prisma.defineExtension` 的函数形态一致；
 * - **钩子执行顺序**：先 `$extends` 的先执行（最外层）。这条和 Prisma 6 运行时
 *   （`getAllQueryCallbacks` 里 `previous.concat(current)`，再从下标 0 往里递归）一致，
 *   叠加顺序的断言全靠它，改这里等于改了被测语义；
 * - `client.goods.findMany(args)` 映射成 `(model='Goods', operation='findMany', args)`；
 * - `$transaction(fn)` 把同一个客户端交给回调，扩展照常生效。
 *
 * 没复刻：真正的 SQL、关系加载、`P2025` 之类的错误码、批量事务数组形态。
 *
 * @packageDocumentation
 */

import type { DelegateOperation, ModelDelegate, QueryHook, QueryHookParams } from '../types'

/** 一次落到「数据库」的调用。 */
export interface RecordedCall {
  /** Prisma 模型名（PascalCase）。 */
  model: string
  /** Prisma 操作名。 */
  operation: string
  /** 走完所有扩展之后、真正要发给数据库的 args。断言就断言它。 */
  args: unknown
}

/** 预设返回值：给定值，或按调用动态算。 */
export type FakeResult = unknown | ((call: RecordedCall) => unknown)

/** 测试侧的控制面。 */
export interface FakePrismaControls {
  /** 按顺序记录的、走完全部扩展后的调用。 */
  readonly calls: RecordedCall[]
  /** 只看某个模型（可再限定操作）的调用。 */
  callsOf(model: string, operation?: string): RecordedCall[]
  /** 预设 `model.operation` 的返回值；`operation` 传 `'*'` 匹配该模型的所有操作。 */
  on(model: string, operation: string, result: FakeResult): void
  /** 预设 `$queryRaw` 的行为（要模拟失败就在函数里 throw）。 */
  onQueryRaw(result: FakeResult): void
  /** 清空记录与预设。 */
  reset(): void
}

/** 替身客户端。索引签名给模型委托，`$` 开头的是客户端方法。 */
export type FakePrismaClient = Record<string, ModelDelegate> & {
  $extends(extension: unknown): FakePrismaClient
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
  $connect(): Promise<void>
  $disconnect(): Promise<void>
  $transaction<T>(fn: (tx: FakePrismaClient) => Promise<T>): Promise<T>
}

/**
 * 从替身客户端上取一个模型委托。
 *
 * 直接写 `client.goods` 走的是索引签名，在 `noUncheckedIndexedAccess` 下类型是
 * `ModelDelegate | undefined`，每个调用点都要补 `?.`——噪音大到会盖住断言本身。
 * 这个函数把收窄集中在一处。
 *
 * @param client - 替身客户端（叠了扩展的也行）
 * @param clientKey - camelCase 的模型属性名，例如 `goods`
 */
export function modelOf(client: object, clientKey: string): ModelDelegate {
  return (client as Record<string, ModelDelegate>)[clientKey] as ModelDelegate
}

/** {@link createFakePrisma} 的选项。 */
export interface FakePrismaOptions {
  /** 没有预设时的兜底返回值，默认 `null`。 */
  defaultResult?: FakeResult
}

interface Core {
  calls: RecordedCall[]
  handlers: Map<string, FakeResult>
  queryRaw: FakeResult
  defaultResult: FakeResult
}

function resolve(result: FakeResult, call: RecordedCall): unknown {
  return typeof result === 'function' ? (result as (c: RecordedCall) => unknown)(call) : result
}

/** camelCase 的委托名还原成 PascalCase 的模型名（`goodsSku` 还原成 `GoodsSku`）。 */
function clientKeyToModel(clientKey: string): string {
  return clientKey.charAt(0).toUpperCase() + clientKey.slice(1)
}

async function execute(
  core: Core,
  model: string,
  operation: string,
  args: unknown,
): Promise<unknown> {
  const call: RecordedCall = { model, operation, args }
  core.calls.push(call)
  const handler = core.handlers.get(`${model}.${operation}`) ?? core.handlers.get(`${model}.*`)
  return handler === undefined ? resolve(core.defaultResult, call) : resolve(handler, call)
}

/** 按 Prisma 的顺序跑钩子链：下标 0 是最外层。 */
async function runHooks(
  core: Core,
  hooks: readonly QueryHook[],
  index: number,
  model: string,
  operation: string,
  args: unknown,
): Promise<unknown> {
  const hook = hooks[index]
  if (hook === undefined) return execute(core, model, operation, args)
  const params: QueryHookParams = {
    model,
    operation,
    args,
    query: (next: unknown) => runHooks(core, hooks, index + 1, model, operation, next),
  }
  return hook(params)
}

function extractQueryHook(extension: unknown): QueryHook | undefined {
  const query = (extension as { query?: unknown } | null)?.query
  const allModels = (query as { $allModels?: unknown } | undefined)?.$allModels
  const all = (allModels as { $allOperations?: unknown } | undefined)?.$allOperations
  return typeof all === 'function' ? (all as QueryHook) : undefined
}

/** 一个 model 组件覆盖：实现 + 它被叠加时的父客户端（`$parent` 就是它）。 */
interface ModelOverrideLayer {
  fn: (this: unknown, args?: unknown) => Promise<unknown>
  parent: FakePrismaClient
}

/**
 * 取出 `model.$allModels` 上的操作覆盖。
 *
 * 复刻的是 Prisma 的 **model 组件**：它替换掉委托上的那个方法，`this` 是「扩展上下文」，
 * 上面有 `$name`（模型名）与 `$parent`（叠加前的客户端）。软删的 `delete` → `update`
 * 改写靠它——用 query 钩子做不到，而且 query 钩子里捕获的客户端引用**不跟事务走**
 * （见 `extensions/soft-delete.ts` 的文件头）。
 */
function extractModelOverrides(
  extension: unknown,
): Record<string, (this: unknown, args?: unknown) => Promise<unknown>> {
  const model = (extension as { model?: unknown } | null)?.model
  const allModels = (model as { $allModels?: unknown } | undefined)?.$allModels
  if (typeof allModels !== 'object' || allModels === null) return {}
  const out: Record<string, (this: unknown, args?: unknown) => Promise<unknown>> = {}
  for (const [operation, fn] of Object.entries(allModels as Record<string, unknown>)) {
    if (typeof fn === 'function') {
      out[operation] = fn as (this: unknown, args?: unknown) => Promise<unknown>
    }
  }
  return out
}

function buildClient(
  core: Core,
  hooks: readonly QueryHook[],
  overrides: ReadonlyMap<string, ModelOverrideLayer> = new Map(),
): FakePrismaClient {
  const delegates = new Map<string, ModelDelegate>()

  const api: Record<string, unknown> = {
    $extends(extension: unknown): FakePrismaClient {
      if (typeof extension === 'function') {
        return (extension as (c: FakePrismaClient) => FakePrismaClient)(client)
      }
      const hook = extractQueryHook(extension)
      const modelOverrides = extractModelOverrides(extension)
      const nextOverrides = new Map(overrides)
      for (const [operation, fn] of Object.entries(modelOverrides)) {
        // `$parent` 是**叠加这一层之前**的客户端，与 Prisma 的语义一致。
        nextOverrides.set(operation, { fn, parent: client })
      }
      return buildClient(core, hook ? [...hooks, hook] : hooks, nextOverrides)
    },
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
      const call: RecordedCall = {
        model: '$queryRaw',
        operation: 'query',
        args: { sql: strings.join('?'), values },
      }
      core.calls.push(call)
      return resolve(core.queryRaw, call)
    },
    async $connect(): Promise<void> {},
    async $disconnect(): Promise<void> {},
    async $transaction<T>(fn: (tx: FakePrismaClient) => Promise<T>): Promise<T> {
      return fn(client)
    },
  }

  const delegateFor = (clientKey: string): ModelDelegate => {
    const cached = delegates.get(clientKey)
    if (cached) return cached
    const model = clientKeyToModel(clientKey)

    /** 不经过 model 覆盖的「原始」调用：直接进 query 钩子链。 */
    const plain =
      (operation: string) =>
      (args?: unknown): Promise<unknown> =>
        runHooks(core, hooks, 0, model, operation, args)

    const delegate = new Proxy({} as ModelDelegate, {
      get(_target, operation): DelegateOperation | string | undefined {
        if (typeof operation !== 'string') return undefined
        const layer = overrides.get(operation)
        if (!layer) return plain(operation)
        // model 覆盖的 `this` 是**扩展上下文**：`$name` / `$parent` + 其余操作走本委托。
        // `Prisma.getExtensionContext` 运行时是恒等函数，所以这个对象会原样交到实现手里。
        const context = new Proxy(
          {},
          {
            get(_t, prop): unknown {
              if (prop === '$name') return model
              if (prop === '$parent') return layer.parent
              if (typeof prop !== 'string') return undefined
              // 上下文上的同名操作仍然指向覆盖实现（与 Prisma 一致），
              // 其余操作走完整钩子链。
              const inner = overrides.get(prop)
              return inner
                ? (args?: unknown): Promise<unknown> => inner.fn.call(context, args)
                : plain(prop)
            },
          },
        )
        return (args?: unknown): Promise<unknown> => layer.fn.call(context, args)
      },
    })
    delegates.set(clientKey, delegate)
    return delegate
  }

  const client = new Proxy(api, {
    get(target, prop): unknown {
      if (typeof prop !== 'string') return undefined
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop]
      return delegateFor(prop)
    },
  }) as unknown as FakePrismaClient

  return client
}

/**
 * 造一个替身客户端 + 它的控制面。
 *
 * @param options - 见 {@link FakePrismaOptions}
 *
 * @example
 * ```ts
 * const { client, controls } = createFakePrisma()
 * controls.on('Goods', 'findMany', [{ id: 'g1' }])
 * const tenant = client.$extends(createTenantExtension({ getTenantId, registered, raw: client }))
 * await tenant.goods.findMany({ where: { name: 'x' } })
 * // 断言真正发出去的 where 被 AND 包住了
 * ```
 */
export function createFakePrisma(options: FakePrismaOptions = {}): {
  client: FakePrismaClient
  controls: FakePrismaControls
} {
  const core: Core = {
    calls: [],
    handlers: new Map(),
    queryRaw: [{ ok: 1 }],
    defaultResult: options.defaultResult ?? null,
  }

  const controls: FakePrismaControls = {
    get calls(): RecordedCall[] {
      return core.calls
    },
    callsOf(model, operation): RecordedCall[] {
      return core.calls.filter(
        (c) => c.model === model && (operation === undefined || c.operation === operation),
      )
    },
    on(model, operation, result): void {
      core.handlers.set(`${model}.${operation}`, result)
    },
    onQueryRaw(result): void {
      core.queryRaw = result
    },
    reset(): void {
      core.calls.length = 0
      core.handlers.clear()
    },
  }

  return { client: buildClient(core, []), controls }
}
