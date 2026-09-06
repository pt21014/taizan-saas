/** `PrismaMembershipProvider` / `CachedMembershipProvider` 单测。 */

import { RawPrismaService } from '@taizan/nest-prisma'
import { createFakePrisma } from '@taizan/nest-prisma/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../testing/fake-clock'
import { FakeMembershipProvider } from '../testing/fake-membership'
import {
  CachedMembershipProvider,
  MEMBERSHIP_TTL_MS,
  PrismaMembershipProvider,
} from './membership.provider'

describe('PrismaMembershipProvider', () => {
  const fake = createFakePrisma()
  /** `RawPrismaService` 只用到 `.client`，直接造一个结构等价的对象最省事。 */
  const raw = { client: fake.client } as unknown as RawPrismaService
  const provider = new PrismaMembershipProvider(raw)

  beforeEach(() => fake.controls.reset())

  it('按 (accountId, tenantId, deletedAt: null) 查，且只 select 需要的列', async () => {
    fake.controls.on('Staff', 'findFirst', {
      id: 'S1',
      status: 'ACTIVE',
      roleIds: ['r1'],
      dataScope: 'ALL',
      isOwner: true,
    })

    const result = await provider.membershipById('A1', 'T1')
    expect(result).toEqual({
      staffId: 'S1',
      status: 'ACTIVE',
      roleIds: ['r1'],
      dataScope: 'ALL',
      isOwner: true,
    })

    const call = fake.controls.callsOf('Staff', 'findFirst')[0]
    expect(call?.args).toMatchObject({
      where: { accountId: 'A1', tenantId: 'T1', deletedAt: null },
    })
  })

  it('查不到回 null', async () => {
    fake.controls.on('Staff', 'findFirst', null)
    expect(await provider.membershipById('A1', 'T1')).toBeNull()
  })

  it('库里冒出没见过的 status 时按 DISABLED 兜底（失败关闭，不是放行）', async () => {
    fake.controls.on('Staff', 'findFirst', {
      id: 'S1',
      status: 'SOMETHING_NEW',
      roleIds: [],
      dataScope: 'ALL',
      isOwner: false,
    })
    expect((await provider.membershipById('A1', 'T1'))?.status).toBe('DISABLED')
  })

  it('没见过的 dataScope 收敛到最小范围 SELF', async () => {
    fake.controls.on('Staff', 'findFirst', {
      id: 'S1',
      status: 'ACTIVE',
      roleIds: [],
      dataScope: 'WHATEVER',
      isOwner: false,
    })
    expect((await provider.membershipById('A1', 'T1'))?.dataScope).toBe('SELF')
  })

  it('roleIds 是 Json 列，脏数据被过滤成 string[]', async () => {
    fake.controls.on('Staff', 'findFirst', {
      id: 'S1',
      status: 'ACTIVE',
      roleIds: ['r1', 42, null, 'r2'],
      dataScope: 'SELF',
      isOwner: false,
    })
    expect((await provider.membershipById('A1', 'T1'))?.roleIds).toEqual(['r1', 'r2'])
  })

  it('roleIds 不是数组时回空数组（而不是崩在守卫里）', async () => {
    fake.controls.on('Staff', 'findFirst', {
      id: 'S1',
      status: 'ACTIVE',
      roleIds: null,
      dataScope: 'SELF',
      isOwner: false,
    })
    expect((await provider.membershipById('A1', 'T1'))?.roleIds).toEqual([])
  })
})

describe('CachedMembershipProvider', () => {
  let clock: FakeClock
  let inner: FakeMembershipProvider
  let cached: CachedMembershipProvider

  beforeEach(() => {
    clock = new FakeClock()
    inner = new FakeMembershipProvider()
    cached = new CachedMembershipProvider(inner, clock)
    inner.set('A1', 'T1', {
      staffId: 'S1',
      status: 'ACTIVE',
      roleIds: ['r1'],
      dataScope: 'SELF',
      isOwner: false,
    })
  })

  it('30 秒内只穿透一次', async () => {
    await cached.membershipById('A1', 'T1')
    clock.advanceSeconds(29)
    await cached.membershipById('A1', 'T1')
    expect(inner.calls).toBe(1)
  })

  it('30 秒后重新穿透（撤权最长延迟就是这个数）', async () => {
    await cached.membershipById('A1', 'T1')
    clock.advance(MEMBERSHIP_TTL_MS)
    await cached.membershipById('A1', 'T1')
    expect(inner.calls).toBe(2)
  })

  it('null 也缓存——被移出店铺的人不该每点一下就查一次库', async () => {
    expect(await cached.membershipById('A9', 'T1')).toBeNull()
    expect(await cached.membershipById('A9', 'T1')).toBeNull()
    expect(inner.calls).toBe(1)
  })

  it('invalidate 后立刻重新查（本实例内 0 延迟）', async () => {
    await cached.membershipById('A1', 'T1')
    inner.patch('A1', 'T1', { status: 'DISABLED' })
    cached.invalidate('A1', 'T1')
    expect((await cached.membershipById('A1', 'T1'))?.status).toBe('DISABLED')
    expect(inner.calls).toBe(2)
  })

  it('invalidate 只动那一条，别人的缓存不受影响', async () => {
    inner.set('A2', 'T1', {
      staffId: 'S2',
      status: 'ACTIVE',
      roleIds: [],
      dataScope: 'SELF',
      isOwner: false,
    })
    await cached.membershipById('A1', 'T1')
    await cached.membershipById('A2', 'T1')
    cached.invalidate('A1', 'T1')
    expect(cached.size).toBe(1)
  })

  it('同一个账号在不同店里的成员关系互不串（缓存 key 含 tenantId）', async () => {
    inner.set('A1', 'T2', {
      staffId: 'S1-in-T2',
      status: 'ACTIVE',
      roleIds: ['owner'],
      dataScope: 'ALL',
      isOwner: true,
    })
    expect((await cached.membershipById('A1', 'T1'))?.staffId).toBe('S1')
    expect((await cached.membershipById('A1', 'T2'))?.staffId).toBe('S1-in-T2')
  })

  it('clear 清空全部', async () => {
    await cached.membershipById('A1', 'T1')
    cached.clear()
    expect(cached.size).toBe(0)
  })
})
