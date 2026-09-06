/**
 * 租户隔离的**决策**逻辑：纯函数、无副作用、不 import 任何 npm 包（含 `@prisma/client`）。
 *
 * 为什么单独抽成一个零依赖的纯函数包：这是整个 SaaS 最不能出错的一段代码——写漏一个
 * 分支，租户之间就会串数据，而且串数据不会报错，只会在某天变成事故。纯函数才能被 100%
 * 单测覆盖、被 CI 反复验证；执行层（Prisma Client Extension）只负责按计划办事，
 * 见 `@taizan/nest-prisma` 的 `createTenantExtension`。
 *
 * ## 四条不可退让（蓝图 §4.2）
 *
 * 1. **`where` 用 `AND` 包裹，不是合并对象。** `{ ...where, tenantId }` 可以被调用方
 *    传入的同名 key 覆盖掉，`{ AND: [{ tenantId }, where] }` 不能——调用方哪怕显式写
 *    `where: { tenantId: '别人' }`，结果也只是「两个条件同时成立」，必然是空集。
 * 2. **`upsert` 显式分三支处理。** `create` 分支注入 `tenantId`，`update` 分支禁止改
 *    `tenantId`，`where` 分支走「先验归属再执行」。把 upsert 混进 create 一类里处理，
 *    等于新建出来的记录可能无归属、更新分支可能改走归属。
 * 3. **`findUnique` 自动补 `select.tenantId`。** 归属校验读的就是这个字段；调用方写了
 *    `select` 却没选它时，校验拿到 `undefined`，会把自己的数据判成别人的、失败关闭返回
 *    `null`——查询本身不报错，只是结果永远为空，极难查。与其指望每个调用点都记得加，
 *    不如在这里补上，多返回一个字段无害。
 * 4. **未识别的操作抛错（失败关闭）。** 租户域模型上遇到清单外的操作一律抛
 *    `UNKNOWN_OPERATION`，而不是放行。否则 Prisma 升级引入新操作时，会悄无声息地多出
 *    一个不受隔离约束的入口。
 *
 * ## 与反面教材的对照
 *
 * 老项目 xiaodian 的 `tenant.extension.ts` 有三个洞，本文件逐条堵死，并在
 * `plan.spec.ts` 里逐条留了证明用例：
 *
 * - **无上下文即放行**（`if (!ctx?.tenantId || !MODELS.has(model)) return query(args)`）：
 *   没登录 / 没解析出租户就查全表。这里改为：租户域模型 + 无 `tenantId` → 抛
 *   `NO_CONTEXT`；只有**非**租户域模型才放行。
 * - **`upsert` 归到 create 一类但只碰 `data`**：而 upsert 根本没有 `data`，等于完全没
 *   处理。这里 upsert 是独立分支。
 * - **`where` 浅展开**（`{ ...where, tenant_id }`）：调用方后写同名键就被覆盖。
 *   这里用 `AND` 包裹。
 *
 * @packageDocumentation
 */

import { TenantScopeError } from './errors'

/**
 * 判断某个模型是否受租户隔离约束的最小接口。
 *
 * `ReadonlySet<string>` 天然满足它，`createTenantModelRegistry()` 的返回值也满足它，
 * 所以决策函数不需要知道注册表是怎么实现的。
 */
export interface TenantModelLookup {
  /** @param model - Prisma 模型名，例如 `Goods` */
  has(model: string): boolean
}

/**
 * 一次 Prisma 调用的隔离计划。执行层照着做即可，不允许自己再加判断。
 *
 * - `passthrough`：非租户域模型，原样执行。
 * - `execute`：`args` 已被改写（`where` 已 `AND` 包裹 / `data` 已注入），直接执行。
 * - `checkResultOwner`：先执行，再校验返回记录的归属；不匹配时按 `throwWhenForeign`
 *   决定返回 `null` 还是抛 `FOREIGN_RESULT`。
 * - `verifyOwnerThenExecute`：先按唯一键查一次归属，确认属于本租户后再执行。
 */
export type ScopePlan =
  | { action: 'passthrough' }
  | { action: 'execute'; args: Record<string, unknown> }
  | { action: 'checkResultOwner'; args: Record<string, unknown>; throwWhenForeign: boolean }
  | { action: 'verifyOwnerThenExecute'; args: Record<string, unknown> }

/** 可以直接往 `where` 上拼条件的操作：读类 + `updateMany` / `deleteMany` 系列。 */
export const WHERE_OPERATIONS: readonly string[] = [
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]

/** 按唯一键定位的读操作：执行后校验结果归属。 */
export const UNIQUE_READ_OPERATIONS: readonly string[] = ['findUnique', 'findUniqueOrThrow']

/** 按唯一键定位、无法安全拼 `where` 的写操作：执行前先查归属。 */
export const UNIQUE_MUTATION_OPERATIONS: readonly string[] = ['update', 'delete', 'upsert']

/** 创建类操作：往 `data` 注入 `tenantId`。 */
export const CREATE_OPERATIONS: readonly string[] = ['create', 'createMany', 'createManyAndReturn']

/**
 * 决策函数认识的全部 Prisma 6 模型操作。
 *
 * 不在这个清单里的操作名 = 抛 `UNKNOWN_OPERATION`。Prisma 升级后如果多出新操作，
 * 必须显式决定它归哪一类，而不是让它默默绕过隔离。
 */
export const SUPPORTED_OPERATIONS: readonly string[] = [
  ...WHERE_OPERATIONS,
  ...UNIQUE_READ_OPERATIONS,
  ...UNIQUE_MUTATION_OPERATIONS,
  ...CREATE_OPERATIONS,
]

const WHERE_OPS = new Set(WHERE_OPERATIONS)
const UNIQUE_READ_OPS = new Set(UNIQUE_READ_OPERATIONS)
const UNIQUE_MUTATION_OPS = new Set(UNIQUE_MUTATION_OPERATIONS)
const CREATE_OPS = new Set(CREATE_OPERATIONS)

/** 一层嵌套写里可能出现的、需要注入 `tenantId` 的子键。 */
const NESTED_CREATE_KEYS = ['create', 'createMany', 'connectOrCreate'] as const

/** 嵌套 create 的注入策略。 */
export type NestedCreateStrategy = 'mapped' | 'all' | 'off'

/** {@link planTenantScope} 的入参。 */
export interface PlanTenantScopeParams {
  /** Prisma 模型名（PascalCase），例如 `Goods`。 */
  model: string
  /** Prisma 操作名，例如 `findMany`。 */
  operation: string
  /** 调用方传入的原始 `args`；决策函数不会修改它，只返回改写后的副本。 */
  args: unknown
  /** 当前租户 id。租户域模型上为空即抛 `NO_CONTEXT`。 */
  tenantId: string
  /** 租户模型注册表，见 `createTenantModelRegistry`。 */
  registered: TenantModelLookup
  /**
   * 关系字段名 → 目标模型名的映射，用于判断一层嵌套 `create` 要不要注入 `tenantId`。
   * 例如 `{ skus: 'GoodsSku' }`。由项目侧从自己的 schema 生成，框架不猜。
   */
  nestedModels?: Readonly<Record<string, string>>
  /**
   * 嵌套 `create` 的注入策略，默认 `'mapped'`。
   *
   * - `'mapped'`：只对 `nestedModels` 里映射到**已登记模型**的关系字段注入（推荐，最安全）。
   * - `'all'`：对所有一层嵌套 `create` 注入，但仍跳过 `nestedModels` 里明确映射到未登记
   *   模型的字段。适合「几乎所有业务表都带 tenantId」的项目；注入到没有该列的表上时
   *   Prisma 会直接报错（响亮失败，不是静默泄漏）。
   * - `'off'`：完全不碰嵌套写。
   */
  nestedCreate?: NestedCreateStrategy
  /**
   * 遇到未登记模型时的行为，默认 `'passthrough'`（平台域表原样放行）。
   * 设为 `'throw'` 可以在测试环境把「新表忘了登记」变成响亮的失败。
   */
  onUnregistered?: 'passthrough' | 'throw'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读出一个写入值里最终会落库的 `tenantId`。
 * Prisma 允许 `tenantId: 'x'` 与 `tenantId: { set: 'x' }` 两种写法，两种都要看住。
 */
function readAssignedTenantId(value: unknown): unknown {
  if (isPlainObject(value) && 'set' in value) return value.set
  return value
}

interface Locator {
  model: string
  operation: string
  tenantId: string
}

/**
 * 拒绝调用方自带的、与当前租户不一致的归属声明。
 *
 * 两种绕过方式都堵：标量 `tenantId`（写成别人的 id），以及关系写 `tenant: { connect }`
 * ——后者正是 xiaodian 那版扩展「检测到就跳过注入」的洞。
 */
function assertOwnershipNotOverridden(
  payload: Record<string, unknown>,
  where: string,
  at: Locator,
): void {
  if ('tenantId' in payload) {
    const assigned = readAssignedTenantId(payload.tenantId)
    if (assigned !== at.tenantId) {
      throw new TenantScopeError(
        'TENANT_ID_CONFLICT',
        `${at.model}.${at.operation} 的 ${where} 里显式写了 tenantId=${String(assigned)}，` +
          `与当前租户 ${at.tenantId} 不一致。归属只能来自租户上下文，不允许由调用方指定。`,
        at,
      )
    }
  }
  if ('tenant' in payload) {
    throw new TenantScopeError(
      'TENANT_ID_CONFLICT',
      `${at.model}.${at.operation} 的 ${where} 里用关系写（tenant: { ... }）设置归属，` +
        `这会绕过标量 tenantId 注入。请删掉它——归属由租户上下文注入。`,
      at,
    )
  }
}

/** 给一行待写入的数据注入 `tenantId`（先校验调用方没有指定别的租户）。 */
function withTenantId(row: unknown, where: string, at: Locator): Record<string, unknown> {
  if (!isPlainObject(row)) {
    throw new TenantScopeError(
      'INVALID_ARGUMENT',
      `${at.model}.${at.operation} 的 ${where} 必须是对象，收到 ${
        row === null ? 'null' : typeof row
      }。`,
      at,
    )
  }
  assertOwnershipNotOverridden(row, where, at)
  return { ...row, tenantId: at.tenantId }
}

interface NestedOptions {
  strategy: NestedCreateStrategy
  models: Readonly<Record<string, string>>
  registered: TenantModelLookup
}

/** 判断某个关系字段的一层嵌套 create 是否应该注入 `tenantId`。 */
function shouldInjectNested(field: string, opts: NestedOptions): boolean {
  if (opts.strategy === 'off') return false
  const mapped = Object.prototype.hasOwnProperty.call(opts.models, field)
    ? opts.models[field]
    : undefined
  if (mapped !== undefined) return opts.registered.has(mapped)
  return opts.strategy === 'all'
}

/**
 * 对**一层**嵌套写里的 `create` / `createMany` / `connectOrCreate.create` 注入 `tenantId`。
 *
 * 明确**不覆盖**的情况见 {@link planTenantScope} 的「已知未覆盖边界」。
 */
function injectNestedCreates(
  data: Record<string, unknown>,
  opts: NestedOptions,
  at: Locator,
): Record<string, unknown> {
  if (opts.strategy === 'off') return data
  let next = data
  const clone = (): Record<string, unknown> => {
    if (next === data) next = { ...data }
    return next
  }

  for (const [field, value] of Object.entries(data)) {
    if (!isPlainObject(value)) continue
    if (!shouldInjectNested(field, opts)) continue

    let relation = value
    const touch = (): Record<string, unknown> => {
      if (relation === value) relation = { ...value }
      return relation
    }

    for (const key of NESTED_CREATE_KEYS) {
      const child = relation[key]
      if (child === undefined) continue
      const label = `${field}.${key}`

      if (key === 'createMany') {
        if (!isPlainObject(child)) continue
        const rows = child.data
        touch()[key] = {
          ...child,
          data: Array.isArray(rows)
            ? rows.map((row) => withTenantId(row, label, at))
            : withTenantId(rows, label, at),
        }
        continue
      }

      if (key === 'connectOrCreate') {
        const entries = Array.isArray(child) ? child : [child]
        const mapped = entries.map((entry) => {
          if (!isPlainObject(entry) || entry.create === undefined) return entry
          return { ...entry, create: withTenantId(entry.create, label, at) }
        })
        touch()[key] = Array.isArray(child) ? mapped : mapped[0]
        continue
      }

      touch()[key] = Array.isArray(child)
        ? child.map((row) => withTenantId(row, label, at))
        : withTenantId(child, label, at)
    }

    if (relation !== value) clone()[field] = relation
  }

  return next
}

/**
 * 保证归属校验能读到 `tenantId`：`select` 存在时补上，`omit` 里把它去掉。
 *
 * `include` 刻意不动：Prisma 的 `include` 只接受关系字段，往里塞标量 `tenantId` 会直接
 * 报验证错误；而只写 `include` 时所有标量字段本来就会返回，`tenantId` 天然可读。
 * 真正的坑是 `omit: { tenantId: true }`（Prisma 5.16+ 新增），它会把校验依据抹掉，
 * 所以这里直接把它剔除。
 */
function ensureTenantIdReadable(args: Record<string, unknown>): Record<string, unknown> {
  let next = args

  if (isPlainObject(args.select) && args.select.tenantId !== true) {
    next = { ...next, select: { ...args.select, tenantId: true } }
  }

  if (isPlainObject(args.omit) && 'tenantId' in args.omit) {
    const omit = { ...args.omit }
    delete omit.tenantId
    next = { ...next }
    if (Object.keys(omit).length === 0) delete next.omit
    else next.omit = omit
  }

  return next
}

/**
 * 给一次 Prisma 调用规划租户隔离动作。**这是整个多租户隔离的唯一决策入口。**
 *
 * 处理顺序（顺序本身就是不变量）：
 * 1. 模型未登记 → `passthrough`（或按 `onUnregistered: 'throw'` 抛
 *    `MODEL_NOT_REGISTERED`）。平台域表要能跨租户查，所以放行发生在租户上下文检查**之前**。
 * 2. 租户域模型 + `tenantId` 为空 → 抛 `NO_CONTEXT`。**绝不退化成查全表。**
 * 3. 按操作分类改写 `args`，不认识的操作抛 `UNKNOWN_OPERATION`。
 *
 * ### 已知未覆盖的边界（不是遗漏，是显式划界）
 *
 * - **`connect` / `disconnect` / `set` 指向的既有记录不校验归属**：决策函数不知道关系
 *   目标表的唯一键形状，也无法查库。跨租户 `connect` 必须由执行层（拿得到 client）或
 *   业务侧校验。
 * - **只覆盖一层嵌套 `create`**：`data.a.create.b.create` 这类第二层不注入。深层嵌套写
 *   请拆成多次调用，或在 `nestedModels` 里配好后由业务侧自查。
 * - **嵌套 `update` / `updateMany` / `deleteMany` / `upsert` 子句不改写**：它们的 `where`
 *   由关系本身限定，但不经过本函数的 `AND` 包裹。
 * - **`$queryRaw` / `$executeRaw` 完全不经过这里**：那是唯一的逃生口，由 spec 3
 *   （`raw-usage.spec.ts`）用白名单 + `// raw-reason:` 注释看住。
 * - **不校验 `where` 里的关系过滤（`some` / `every`）是否跨租户**：`AND` 只保证顶层表的
 *   归属；关系过滤命中的关联表由它自己的隔离计划负责。
 *
 * @param params - 见 {@link PlanTenantScopeParams}
 * @returns 执行层照着办的 {@link ScopePlan}
 * @throws {@link TenantScopeError} 原因为 `NO_CONTEXT` / `UNKNOWN_OPERATION` /
 *   `TENANT_ID_CONFLICT` / `MODEL_NOT_REGISTERED` / `INVALID_ARGUMENT`
 *
 * @example
 * ```ts
 * const plan = planTenantScope({
 *   model: 'Goods',
 *   operation: 'findMany',
 *   args: { where: { tenantId: '别人' } },
 *   tenantId: 't1',
 *   registered: new Set(['Goods']),
 * })
 * // plan.args.where → { AND: [{ tenantId: 't1' }, { tenantId: '别人' }] } —— 必然空集
 * ```
 */
export function planTenantScope(params: PlanTenantScopeParams): ScopePlan {
  const { model, operation, tenantId, registered } = params

  if (!registered.has(model)) {
    if (params.onUnregistered === 'throw') {
      throw new TenantScopeError(
        'MODEL_NOT_REGISTERED',
        `模型 ${model} 没有登记进租户模型注册表。带 tenantId 的新表必须 register()，` +
          `确属平台域表请写进 verifySchema 的 allowlist 并附理由。`,
        { model, operation, tenantId },
      )
    }
    return { action: 'passthrough' }
  }

  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new TenantScopeError(
      'NO_CONTEXT',
      `租户上下文缺失：${model}.${operation} 必须在租户上下文中执行（或改用 prisma.raw，` +
        `逃生口仅限登录跨租户找账号 / 支付回调定位租户 / 平台后台三处）。`,
      { model, operation },
    )
  }

  const at: Locator = { model, operation, tenantId }

  if (params.args !== undefined && params.args !== null && !isPlainObject(params.args)) {
    throw new TenantScopeError(
      'INVALID_ARGUMENT',
      `${model}.${operation} 的 args 必须是对象或 undefined，收到 ${typeof params.args}。`,
      at,
    )
  }

  const args: Record<string, unknown> = { ...((params.args ?? {}) as Record<string, unknown>) }
  const nested: NestedOptions = {
    strategy: params.nestedCreate ?? 'mapped',
    models: params.nestedModels ?? {},
    registered,
  }

  if (WHERE_OPS.has(operation)) {
    // 不可退让 1：AND 包裹而不是对象合并——调用方自己传的 tenantId 覆盖不掉这一层。
    args.where = { AND: [{ tenantId }, args.where ?? {}] }
    if (operation === 'updateMany' || operation === 'updateManyAndReturn') {
      if (isPlainObject(args.data)) assertOwnershipNotOverridden(args.data, 'data', at)
    }
    return { action: 'execute', args }
  }

  if (CREATE_OPS.has(operation)) {
    if (operation === 'create') {
      const data = withTenantId(args.data ?? {}, 'data', at)
      args.data = injectNestedCreates(data, nested, at)
    } else {
      const rows = Array.isArray(args.data) ? args.data : [args.data ?? {}]
      args.data = rows.map((row) => withTenantId(row, 'data', at))
    }
    return { action: 'execute', args }
  }

  if (UNIQUE_READ_OPS.has(operation)) {
    // 不可退让 3：归属校验读的就是 tenantId，select/omit 不能把它藏起来。
    return {
      action: 'checkResultOwner',
      args: ensureTenantIdReadable(args),
      throwWhenForeign: operation === 'findUniqueOrThrow',
    }
  }

  if (UNIQUE_MUTATION_OPS.has(operation)) {
    // 不可退让 2：upsert 三分支各管各的，绝不混进 create 一类。
    if (operation === 'upsert') {
      const create = withTenantId(args.create ?? {}, 'create', at)
      args.create = injectNestedCreates(create, nested, at)
      if (isPlainObject(args.update)) {
        assertOwnershipNotOverridden(args.update, 'update', at)
        args.update = injectNestedCreates(args.update, nested, at)
      }
    } else if (operation === 'update' && isPlainObject(args.data)) {
      assertOwnershipNotOverridden(args.data, 'data', at)
      args.data = injectNestedCreates(args.data, nested, at)
    }
    return { action: 'verifyOwnerThenExecute', args: ensureTenantIdReadable(args) }
  }

  // 不可退让 4：失败关闭。
  throw new TenantScopeError(
    'UNKNOWN_OPERATION',
    `未支持的操作 ${model}.${operation}：为避免绕过租户隔离，请先在 @taizan/tenant-scope ` +
      `的 plan.ts 里明确它属于哪一类（where / create / uniqueRead / uniqueMutation）。`,
    at,
  )
}

/** {@link assertResultOwner} 的入参。 */
export interface AssertResultOwnerParams<T> {
  /** Prisma 模型名。 */
  model: string
  /** Prisma 操作名。 */
  operation: string
  /** 当前租户 id。 */
  tenantId: string
  /** 数据库返回的记录（可能为 `null`）。 */
  record: T | null | undefined
  /** 归属不符时是抛 `FOREIGN_RESULT`（`findUniqueOrThrow`）还是返回 `null`。 */
  throwWhenForeign: boolean
}

/**
 * `checkResultOwner` 计划的配套校验器：判断返回记录是否属于当前租户。
 *
 * **失败关闭**：记录上读不到 `tenantId`（被 `select` / `omit` 藏掉，或根本不是租户域表）
 * 一律判为「不属于本租户」。宁可查不到，也不能把别人的数据发出去。
 *
 * @param params - 见 {@link AssertResultOwnerParams}
 * @returns 属于本租户时返回原记录，否则返回 `null`
 * @throws {@link TenantScopeError} 原因 `FOREIGN_RESULT`（仅当 `throwWhenForeign` 为真）
 */
export function assertResultOwner<T>(params: AssertResultOwnerParams<T>): T | null {
  const { model, operation, tenantId, record, throwWhenForeign } = params
  if (record === null || record === undefined) return null

  const owner = isPlainObject(record) ? record.tenantId : undefined
  if (owner === tenantId) return record

  if (throwWhenForeign) {
    throw new TenantScopeError(
      'FOREIGN_RESULT',
      `${model}.${operation} 命中的记录不属于当前租户 ${tenantId}` +
        `（记录归属：${owner === undefined ? '读不到 tenantId' : String(owner)}）。`,
      { model, operation, tenantId },
    )
  }
  return null
}

/**
 * 模型名 → Prisma client 上的属性名（`GoodsSku` → `goodsSku`）。
 *
 * @param model - Prisma 模型名（PascalCase）
 * @returns client 上的 camelCase 属性名
 */
export function modelToClientKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}
