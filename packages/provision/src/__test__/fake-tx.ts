/**
 * 内存版 {@link ProvisionTx}：**把调用序列逐条录下来**。
 *
 * 本包最要紧的两条断言只能这么写：
 *
 * - **失败时不会部分创建**——不是「事务会回滚」（那是 Prisma 的事，本包测不到），
 *   而是「在失败点之前一步都没多走」，靠比对截断后的调用序列；
 * - **`PLATFORM` 与 `SIGNUP` 写出来的东西完全一样**——靠逐字节比对两次运行的调用序列。
 *
 * 它不是一个 Prisma 模拟器：不查唯一索引、不回滚、不管关系。只记账。
 */

import type { ProvisionTx, RolePresetRow, StaffAccountRow } from '../types'

/** 一次被记下来的调用。 */
export interface RecordedCall {
  model: string
  method: string
  args: unknown
}

/** 在第 `nth`（1 起算，默认 1）次调用 `model.method` 时抛错。 */
export interface FailAt {
  model: string
  method: string
  nth?: number
}

/** {@link createFakeTx} 的选项。 */
export interface FakeTxOptions {
  /** 这些 slug 已经被占了。 */
  takenSlugs?: readonly string[]
  /** 已存在的登录账号。 */
  accounts?: readonly StaffAccountRow[]
  /** `RolePreset` 表里的行；默认 {@link FAKE_PRESETS}。 */
  presets?: readonly RolePresetRow[]
  /** 挂不挂 `quotaCounter` delegate（不挂 = 调用方的 client 上没有这张表）。 */
  quotaCounter?: boolean
  /** 注入一次失败，见 {@link FailAt}。 */
  failAt?: FailAt
}

/** {@link createFakeTx} 的产出。 */
export interface FakeTx {
  tx: ProvisionTx
  calls: RecordedCall[]
  /** `model.method` 形式的调用序列。 */
  seq(): string[]
  /** 某个写调用的 `data` 载荷（按调用顺序）。 */
  payloads(model: string, method: string): Array<Record<string, unknown>>
}

/** 默认的 ADMIN 侧内置模板：与 `@taizan/prisma-base` 的 `BASE_ROLE_PRESETS` 同形。 */
export const FAKE_PRESETS: readonly RolePresetRow[] = [
  { code: 'manager', name: '店长', side: 'ADMIN', permissionCodes: [], builtin: true },
  { code: 'owner', name: '店主', side: 'ADMIN', permissionCodes: ['*'], builtin: true },
  { code: 'staff', name: '普通员工', side: 'ADMIN', permissionCodes: [], builtin: true },
]

/** 确定性的 id 生成器：`id-1`、`id-2`…… 序列比对要求它可复现。 */
export function createIdGen(prefix = 'id'): () => string {
  let n = 0
  return () => {
    n += 1
    return `${prefix}-${String(n)}`
  }
}

function dataOf(args: unknown): Record<string, unknown> {
  const data = (args as { data?: unknown }).data
  return (data ?? {}) as Record<string, unknown>
}

/** 建一个会记账的假事务客户端。 */
export function createFakeTx(options: FakeTxOptions = {}): FakeTx {
  const calls: RecordedCall[] = []
  const taken = new Set(options.takenSlugs ?? [])
  const accounts = options.accounts ?? []
  const presets = options.presets ?? FAKE_PRESETS
  const counters = new Map<string, number>()

  const record = (model: string, method: string, args: unknown): void => {
    calls.push({ model, method, args })
    const key = `${model}.${method}`
    const times = (counters.get(key) ?? 0) + 1
    counters.set(key, times)
    const fail = options.failAt
    if (fail !== undefined && fail.model === model && fail.method === method) {
      if (times === (fail.nth ?? 1)) throw new Error(`fake-tx: ${key} 第 ${String(times)} 次失败`)
    }
  }

  const tx: ProvisionTx = {
    tenant: {
      findUnique: (args) => {
        record('tenant', 'findUnique', args)
        return Promise.resolve(taken.has(args.where.slug) ? { id: 'existing-tenant' } : null)
      },
      create: (args) => {
        record('tenant', 'create', args)
        const data = dataOf(args)
        return Promise.resolve({ id: String(data.id), slug: String(data.slug) })
      },
    },
    staffAccount: {
      findUnique: (args) => {
        record('staffAccount', 'findUnique', args)
        return Promise.resolve(accounts.find((row) => row.phone === args.where.phone) ?? null)
      },
      create: (args) => {
        record('staffAccount', 'create', args)
        return Promise.resolve({ id: String(dataOf(args).id) })
      },
    },
    role: {
      create: (args) => {
        record('role', 'create', args)
        const data = dataOf(args)
        return Promise.resolve({ id: String(data.id), code: String(data.code) })
      },
    },
    staff: {
      create: (args) => {
        record('staff', 'create', args)
        return Promise.resolve({ id: String(dataOf(args).id) })
      },
    },
    rolePreset: {
      findMany: (args) => {
        record('rolePreset', 'findMany', args)
        return Promise.resolve(
          presets
            .filter((row) => row.side === args.where.side && row.builtin === args.where.builtin)
            .map((row) => ({ ...row })),
        )
      },
    },
  }

  if (options.quotaCounter === true) {
    tx.quotaCounter = {
      createMany: (args) => {
        record('quotaCounter', 'createMany', args)
        return Promise.resolve({ count: args.data.length })
      },
    }
  }

  return {
    tx,
    calls,
    seq: () => calls.map((call) => `${call.model}.${call.method}`),
    payloads: (model, method) =>
      calls
        .filter((call) => call.model === model && call.method === method)
        .map((c) => dataOf(c.args)),
  }
}
