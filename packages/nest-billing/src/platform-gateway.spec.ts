/**
 * T1-4 的验收用例 ⑧⑨⑩（配额三态 + 乐观锁重试 + 30 秒缓存）。
 *
 * 这里不起 Nest app：被测的是「读库 → 交给规则函数 → 把计数写回去」这条链路本身，
 * 起 app 只会把它埋进 HTTP 噪音里。装配那一半由 `billing-gate.spec.ts` 负责。
 */

import { ErrorCode } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import { FakeClock } from '@taizan/nest-auth/testing'
import type { PrismaService } from '@taizan/nest-prisma'
import {
  createFakePrisma,
  type FakePrismaControls,
  type RecordedCall,
} from '@taizan/nest-prisma/testing'
import { describe, expect, it } from 'vitest'
import {
  GATE_CACHE_TTL_MS,
  normalizeFeatures,
  normalizeQuotas,
  PrismaPlatformGateway,
} from './platform-gateway'

const TENANT = 'TENANT000000000000000000A'
const PLAN = 'PLAN00000000000000000001'

interface Ctx {
  gateway: PrismaPlatformGateway
  controls: FakePrismaControls
  clock: FakeClock
}

interface SetupOptions {
  quotas?: unknown
  features?: unknown
  planId?: string | null
  status?: string
  overrides?: Record<string, number | null>
  cacheTtlMs?: number
}

/** 造一个只挂了 `raw` 句柄的 `PrismaService` 替身。 */
function setup(options: SetupOptions = {}): Ctx {
  const fake = createFakePrisma()
  const clock = new FakeClock(Date.UTC(2026, 5, 15, 4, 0, 0))

  fake.controls.on('Tenant', 'findUnique', () => ({
    id: TENANT,
    slug: 'demo',
    name: '示例小店',
    status: options.status ?? 'ACTIVE',
    planId: options.planId === undefined ? PLAN : options.planId,
    planExpireAt: new Date('2099-12-31T15:59:59.999Z'),
    trialEndAt: null,
    graceDays: 0,
  }))
  fake.controls.on('Plan', 'findUnique', () => ({
    id: PLAN,
    code: 'basic',
    name: '基础版',
    quotas: options.quotas ?? {},
    features: options.features ?? null,
  }))

  const prisma = { raw: fake.client } as unknown as PrismaService
  const gateway = new PrismaPlatformGateway(prisma, clock, undefined, {
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.overrides !== undefined
      ? { loadOverrides: async (): Promise<Record<string, number | null>> => options.overrides! }
      : {}),
  })

  return { gateway, controls: fake.controls, clock }
}

/** 让 `QuotaCounter` 表表现得像一张真表（一行内存记录）。 */
function withCounter(
  controls: FakePrismaControls,
  initial: { id: string; used: number; version: number } | null,
  updateResults?: number[],
): { row: { id: string; used: number; version: number } | null; creates: unknown[] } {
  const state = { row: initial, creates: [] as unknown[] }
  let updateIndex = 0

  controls.on('QuotaCounter', 'findFirst', () => (state.row === null ? null : { ...state.row }))
  controls.on('QuotaCounter', 'create', (call: RecordedCall) => {
    const data = (call.args as { data: { id: string; used: number } }).data
    state.creates.push(data)
    state.row = { id: data.id, used: data.used, version: 0 }
    return state.row
  })
  controls.on('QuotaCounter', 'updateMany', (call: RecordedCall) => {
    const scripted = updateResults?.[updateIndex]
    updateIndex += 1
    if (scripted === 0) {
      // 模拟一次乐观锁冲突：命中 0 行，且别人已经把 used 推到了 +1、version 也 +1。
      if (state.row !== null)
        state.row = { ...state.row, used: state.row.used + 1, version: state.row.version + 1 }
      return { count: 0 }
    }
    const data = (call.args as { data: { used: number } }).data
    if (state.row !== null)
      state.row = { ...state.row, used: data.used, version: state.row.version + 1 }
    return { count: 1 }
  })

  return state
}

describe('用例⑧：配额三态', () => {
  it('limit=0 时 consume 抛 1540301——0 是「一个都不给」，不是「没配」', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: 0 } })
    withCounter(controls, null)
    const err = await gateway.consumeQuota(TENANT, 'STAFF', 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BizException)
    expect((err as BizException).code).toBe(ErrorCode.QUOTA_EXCEEDED.code)
    expect((err as BizException).code).toBe(1540301)
  })

  it('limit=null（显式不限量）随便加', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: null } })
    withCounter(controls, { id: 'C1', used: 9999, version: 3 })
    const r = await gateway.consumeQuota(TENANT, 'STAFF', 100)
    expect(r.limit).toBeNull()
    expect(r.used).toBe(10_099)
    expect(r.remaining).toBeNull()
  })

  it('套餐里根本没这个 key 也是不限量（缺省 = null）', async () => {
    const { gateway, controls } = setup({ quotas: { STORE: 1 } })
    withCounter(controls, null)
    const r = await gateway.checkQuota(TENANT, 'STAFF', 50)
    expect(r.ok).toBe(true)
    expect(r.limit).toBeNull()
  })

  it('used + delta 恰好等于 limit 时放行，超一个就拒', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: 3 } })
    withCounter(controls, { id: 'C1', used: 2, version: 0 })
    await expect(gateway.consumeQuota(TENANT, 'STAFF', 1)).resolves.toMatchObject({
      used: 3,
      remaining: 0,
    })

    const two = setup({ quotas: { STAFF: 3 } })
    withCounter(two.controls, { id: 'C1', used: 2, version: 0 })
    await expect(two.gateway.consumeQuota(TENANT, 'STAFF', 2)).rejects.toThrow()
  })

  it('租户覆盖优先于套餐值', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: 3 }, overrides: { STAFF: 10 } })
    withCounter(controls, { id: 'C1', used: 3, version: 0 })
    const r = await gateway.consumeQuota(TENANT, 'STAFF', 5)
    expect(r.limit).toBe(10)
    expect(r.used).toBe(8)
  })

  it('租户覆盖里显式的 null 表示「这一项改成不限量」，而不是「没有覆盖」', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: 1 }, overrides: { STAFF: null } })
    withCounter(controls, { id: 'C1', used: 50, version: 0 })
    const r = await gateway.consumeQuota(TENANT, 'STAFF', 1)
    expect(r.limit).toBeNull()
  })

  it('release 不会把计数减成负数', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: 3 } })
    withCounter(controls, { id: 'C1', used: 1, version: 0 })
    const r = await gateway.releaseQuota(TENANT, 'STAFF', 5)
    expect(r.used).toBe(0)
  })

  it('没有计数行时第一次 consume 会建一行', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: 3 } })
    const state = withCounter(controls, null)
    await gateway.consumeQuota(TENANT, 'STAFF', 1)
    expect(state.creates).toHaveLength(1)
    expect((state.creates[0] as { used: number }).used).toBe(1)
  })

  it('delta 传负数直接 TypeError——想减就用 releaseQuota', async () => {
    const { gateway } = setup({ quotas: { STAFF: 3 } })
    await expect(gateway.consumeQuota(TENANT, 'STAFF', -1)).rejects.toThrow(TypeError)
  })
})

describe('用例⑨：乐观锁冲突重试', () => {
  it('第一次 updateMany 命中 0 行时重读重判，最终写成功', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: 10 } })
    // 脚本：第一次 count=0（有人抢先），第二次 count=1。
    withCounter(controls, { id: 'C1', used: 1, version: 0 }, [0, 1])

    const r = await gateway.consumeQuota(TENANT, 'STAFF', 1)
    // 重试时读到的是别人写完之后的 used=2，所以最终是 3 而不是 2——
    // 这正是乐观锁要保住的：两个并发请求各自 +1，不会互相覆盖。
    expect(r.used).toBe(3)
    expect(controls.callsOf('QuotaCounter', 'updateMany')).toHaveLength(2)
  })

  it('重试时会重新判上限：冲突让计数刚好顶满，第二遍就该拒', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: 2 } })
    withCounter(controls, { id: 'C1', used: 1, version: 0 }, [0, 1])
    // 第一遍 used=1，1+1=2 ≤ 2 放行；冲突后 used 变成 2，2+1=3 > 2 拒。
    await expect(gateway.consumeQuota(TENANT, 'STAFF', 1)).rejects.toThrow(BizException)
  })

  it('updateMany 里带上了 version 条件与 version+1（乐观锁的两半）', async () => {
    const { gateway, controls } = setup({ quotas: { STAFF: 10 } })
    withCounter(controls, { id: 'C1', used: 1, version: 7 })
    await gateway.consumeQuota(TENANT, 'STAFF', 1)
    const call = controls.callsOf('QuotaCounter', 'updateMany')[0]
    expect(call?.args).toMatchObject({
      where: { id: 'C1', version: 7 },
      data: { used: 2, version: { increment: 1 } },
    })
  })
})

describe('用例⑩：30 秒缓存', () => {
  it('TTL 内不重复查库', async () => {
    const { gateway, controls, clock } = setup()
    await gateway.getTenant(TENANT)
    await gateway.getTenant(TENANT)
    clock.advance(GATE_CACHE_TTL_MS - 1)
    await gateway.getTenant(TENANT)
    expect(controls.callsOf('Tenant', 'findUnique')).toHaveLength(1)
  })

  it('TTL 过了自动刷新', async () => {
    const { gateway, controls, clock } = setup()
    await gateway.getTenant(TENANT)
    clock.advance(GATE_CACHE_TTL_MS)
    await gateway.getTenant(TENANT)
    expect(controls.callsOf('Tenant', 'findUnique')).toHaveLength(2)
  })

  it('invalidate 之后立刻刷新——商家付完钱不能再等 30 秒', async () => {
    const { gateway, controls } = setup()
    await gateway.getTenant(TENANT)
    gateway.invalidate(TENANT)
    await gateway.getTenant(TENANT)
    expect(controls.callsOf('Tenant', 'findUnique')).toHaveLength(2)
  })

  it('「租户不存在」也进缓存——否则一个刷不存在 slug 的爬虫能把库打穿', async () => {
    const fake = createFakePrisma()
    fake.controls.on('Tenant', 'findUnique', () => null)
    const prisma = { raw: fake.client } as unknown as PrismaService
    const gateway = new PrismaPlatformGateway(prisma, new FakeClock(), undefined, undefined)
    expect(await gateway.getTenant('NOPE')).toBeNull()
    expect(await gateway.getTenant('NOPE')).toBeNull()
    expect(fake.controls.callsOf('Tenant', 'findUnique')).toHaveLength(1)
  })

  it('cacheTtlMs 可覆盖', async () => {
    const { gateway, controls, clock } = setup({ cacheTtlMs: 1000 })
    await gateway.getTenant(TENANT)
    clock.advance(1000)
    await gateway.getTenant(TENANT)
    expect(controls.callsOf('Tenant', 'findUnique')).toHaveLength(2)
  })
})

describe('读租户：raw 句柄与 Json 列的规范化', () => {
  it('没有套餐时不去查 Plan 表', async () => {
    const { gateway, controls } = setup({ planId: null })
    const view = await gateway.getTenant(TENANT)
    expect(view?.features).toBeNull()
    expect(view?.quotas).toEqual({})
    expect(controls.callsOf('Plan', 'findUnique')).toHaveLength(0)
  })

  it('认不出的租户状态直接抛，不猜', async () => {
    const { gateway } = setup({ status: 'ARCHIVED_BY_SOMEONE' })
    await expect(gateway.getTenant(TENANT)).rejects.toThrow(/认不出的租户状态/)
  })

  it('hasFeature 对不存在的租户回 false，不是「全部可用」', async () => {
    const fake = createFakePrisma()
    fake.controls.on('Tenant', 'findUnique', () => null)
    const prisma = { raw: fake.client } as unknown as PrismaService
    const gateway = new PrismaPlatformGateway(prisma, new FakeClock(), undefined, undefined)
    expect(await gateway.hasFeature('NOPE', 'marketing')).toBe(false)
  })

  it('normalizeFeatures：坏形状当 null（全部可用），空数组保留', () => {
    expect(normalizeFeatures(null)).toBeNull()
    expect(normalizeFeatures({ a: 1 })).toBeNull()
    expect(normalizeFeatures('marketing')).toBeNull()
    expect(normalizeFeatures([])).toEqual([])
    expect(normalizeFeatures(['a', 2, '', 'b'])).toEqual(['a', 'b'])
  })

  it('normalizeQuotas：null 保留（不限量），非法值丢弃（回落成缺省=不限量）', () => {
    expect(normalizeQuotas({ STAFF: 0, STORE: null, MEMBER: -1, X: 1.5, Y: 'z' })).toEqual({
      STAFF: 0,
      STORE: null,
    })
    expect(normalizeQuotas(null)).toEqual({})
    expect(normalizeQuotas([1, 2])).toEqual({})
  })
})
