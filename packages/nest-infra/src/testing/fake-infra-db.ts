/**
 * `createFakeInfraDb`：本包用到的四张平台域表的内存替身。
 *
 * 为什么不用 `@taizan/nest-prisma/testing` 的 `createFakePrisma`：那一份只**记录**
 * 调用、按预设返回值，不存行。而这里要断言的恰恰是「写进去的行长什么样」
 * ——`CronRun` 同一 tick 只有一条、死信重放之后 `resolvedAt` 被标上了——
 * 这些都要求读得回自己刚写的东西。
 *
 * 只实现了本包真正用到的那点 Prisma 语义（`create` / `update` / `upsert` /
 * `findUnique` / `findMany` + 少量 where 操作符）。它不是 Prisma 的通用替身，
 * 真库上的验收在 `apps/api` 的 e2e 里。
 *
 * @packageDocumentation
 */

/** 一行记录。 */
export type FakeRow = Record<string, unknown>

/** 内存库句柄。 */
export interface FakeInfraDb {
  /** 当成 `PrismaService` 用（只有 `raw` / `tenant` 两个句柄，指向同一份数据）。 */
  readonly prisma: { raw: object; tenant: object }
  /** 直接拿某张表的全部行（按插入顺序）。 */
  rows(model: string): FakeRow[]
  /** 清空。 */
  reset(): void
  /** 让下一次对某个 `model.operation` 的调用抛错（测「写库失败不能吞」用）。 */
  failNext(model: string, operation: string, error?: Error): void
}

interface Store {
  tables: Map<string, FakeRow[]>
  failures: Map<string, Error>
}

/** 建一个内存库。 */
export function createFakeInfraDb(): FakeInfraDb {
  const store: Store = { tables: new Map(), failures: new Map() }
  const client = buildClient(store)

  return {
    prisma: { raw: client, tenant: client },
    rows(model: string): FakeRow[] {
      return [...(store.tables.get(model) ?? [])]
    },
    reset(): void {
      store.tables.clear()
      store.failures.clear()
    },
    failNext(model: string, operation: string, error?: Error): void {
      store.failures.set(
        `${model}.${operation}`,
        error ?? new Error(`[fake-infra-db] ${model}.${operation} 被故意打挂`),
      )
    },
  }
}

function buildClient(store: Store): object {
  // process-local: 内存替身的存储本体，只在单个测试进程里活着。
  const delegates = new Map<string, object>()
  return new Proxy(
    {},
    {
      get(_target, prop: string | symbol): unknown {
        if (typeof prop !== 'string') return undefined
        const existing = delegates.get(prop)
        if (existing) return existing
        // 委托名是 camelCase（`cronRun`），但表名按 Prisma 的模型名存（`CronRun`），
        // 这样 `rows('CronRun')` 和 schema 里的写法对得上。
        const delegate = makeDelegate(store, prop.charAt(0).toUpperCase() + prop.slice(1))
        delegates.set(prop, delegate)
        return delegate
      },
    },
  )
}

function makeDelegate(store: Store, model: string): object {
  const table = (): FakeRow[] => {
    const rows = store.tables.get(model)
    if (rows) return rows
    const fresh: FakeRow[] = []
    store.tables.set(model, fresh)
    return fresh
  }

  const guard = (operation: string): void => {
    const key = `${model}.${operation}`
    const err = store.failures.get(key)
    if (err) {
      store.failures.delete(key)
      throw err
    }
  }

  return {
    create: async (args: { data: FakeRow }): Promise<FakeRow> => {
      guard('create')
      const row = { ...args.data }
      table().push(row)
      return row
    },
    update: async (args: { where: FakeRow; data: FakeRow }): Promise<FakeRow> => {
      guard('update')
      const row = table().find((r) => matches(r, args.where))
      if (!row) throw new Error(`[fake-infra-db] ${model}.update 找不到记录`)
      Object.assign(row, args.data)
      return row
    },
    upsert: async (args: {
      where: FakeRow
      create: FakeRow
      update: FakeRow
    }): Promise<FakeRow> => {
      guard('upsert')
      const row = table().find((r) => matches(r, args.where))
      if (row) {
        Object.assign(row, args.update)
        return row
      }
      const created = { ...args.create }
      table().push(created)
      return created
    },
    findUnique: async (args: { where: FakeRow }): Promise<FakeRow | null> => {
      guard('findUnique')
      return table().find((r) => matches(r, args.where)) ?? null
    },
    findFirst: async (args?: { where?: FakeRow }): Promise<FakeRow | null> => {
      guard('findFirst')
      return table().find((r) => matches(r, args?.where ?? {})) ?? null
    },
    findMany: async (args?: {
      where?: FakeRow
      orderBy?: Record<string, 'asc' | 'desc'>
      take?: number
    }): Promise<FakeRow[]> => {
      guard('findMany')
      let rows = table().filter((r) => matches(r, args?.where ?? {}))
      const orderBy = args?.orderBy
      if (orderBy) {
        const [field, direction] = Object.entries(orderBy)[0] ?? []
        if (field) {
          rows = [...rows].sort(
            (a, b) => compare(a[field], b[field]) * (direction === 'desc' ? -1 : 1),
          )
        }
      }
      return args?.take !== undefined ? rows.slice(0, args.take) : rows
    },
    count: async (args?: { where?: FakeRow }): Promise<number> => {
      guard('count')
      return table().filter((r) => matches(r, args?.where ?? {})).length
    },
    deleteMany: async (args?: { where?: FakeRow }): Promise<{ count: number }> => {
      guard('deleteMany')
      const rows = table()
      const kept = rows.filter((r) => !matches(r, args?.where ?? {}))
      const removed = rows.length - kept.length
      store.tables.set(model, kept)
      return { count: removed }
    },
  }
}

/** 支持等值、`in`、`lte/lt/gte/gt`，以及「复合唯一键」那种嵌套对象（`scope_key`）。 */
function matches(row: FakeRow, where: FakeRow): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (isPlainObject(condition)) {
      // 复合唯一键：`{ scope_key: { scope, key } }`——键名本身不是列，展开里面的字段比。
      if (!hasOperator(condition)) {
        if (!matches(row, condition)) return false
        continue
      }
      if (!matchOperator(row[field], condition)) return false
      continue
    }
    if (!Object.is(normalize(row[field]), normalize(condition))) return false
  }
  return true
}

function matchOperator(value: unknown, condition: Record<string, unknown>): boolean {
  for (const [op, operand] of Object.entries(condition)) {
    switch (op) {
      case 'in':
        if (
          !Array.isArray(operand) ||
          !operand.some((o) => Object.is(normalize(value), normalize(o)))
        )
          return false
        break
      case 'notIn':
        if (
          Array.isArray(operand) &&
          operand.some((o) => Object.is(normalize(value), normalize(o)))
        )
          return false
        break
      case 'lte':
        if (compare(value, operand) > 0) return false
        break
      case 'lt':
        if (compare(value, operand) >= 0) return false
        break
      case 'gte':
        if (compare(value, operand) < 0) return false
        break
      case 'gt':
        if (compare(value, operand) <= 0) return false
        break
      case 'not':
        if (Object.is(normalize(value), normalize(operand))) return false
        break
      default:
        throw new Error(`[fake-infra-db] 不支持的 where 操作符：${op}`)
    }
  }
  return true
}

// process-local: 只读的操作符字面量表，不是状态。
const OPERATORS = new Set(['in', 'notIn', 'lte', 'lt', 'gte', 'gt', 'not'])

function hasOperator(condition: Record<string, unknown>): boolean {
  return Object.keys(condition).some((k) => OPERATORS.has(k))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  )
}

function normalize(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value
}

function compare(a: unknown, b: unknown): number {
  const x = normalize(a)
  const y = normalize(b)
  if (typeof x === 'number' && typeof y === 'number') return x - y
  return String(x).localeCompare(String(y))
}
