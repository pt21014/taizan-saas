import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import { HealthRegistry } from '@taizan/nest-core'
import { isUlid } from '@taizan/contracts'
import { isTenantScopeError } from '@taizan/tenant-scope'
import { beforeEach, describe, expect, it } from 'vitest'
import { OptimisticLockError } from './errors'
import { PrismaModule } from './prisma.module'
import type { PrismaModuleOptions } from './prisma.options'
import { PrismaService } from './prisma.service'
import { RawPrismaService } from './raw-prisma.service'
import { createFakePrisma, modelOf, type FakePrismaControls } from './testing/fake-prisma-client'

const NOW = new Date('2026-01-02T03:04:05.000Z')
// `Staff` **登记了租户隔离但没登记软删**——这个组合专门用来验「不在软删名单里的
// 模型，delete 原样落库，但仍然经过租户扩展」。
const REGISTERED = new Set(['Goods', 'Staff'])
const SOFT_DELETE = new Set(['Goods'])

let tenantId: string | undefined
let controls: FakePrismaControls
let service: PrismaService

function baseOptions(client: unknown): PrismaModuleOptions {
  return {
    registered: REGISTERED,
    softDeleteModels: SOFT_DELETE,
    client: client as object,
    getTenantId: () => tenantId,
    now: () => NOW,
    connectOnInit: false,
  }
}

beforeEach(() => {
  tenantId = 't1'
  const fake = createFakePrisma()
  controls = fake.controls
  service = new PrismaService(fake.client, baseOptions(fake.client))
})

describe('PrismaService 的扩展叠加顺序', () => {
  it('⑨ tenant 在外层：软删条件包在最外，租户的 AND 完整地留在里面，谁也盖不住谁', async () => {
    await modelOf(service.tenant, 'goods').findMany({ where: { name: 'x' } })

    expect(controls.callsOf('Goods', 'findMany')[0]?.args).toEqual({
      where: {
        // 外层是软删（后加的扩展在内层，所以它的包裹反而在外面一层 where 上）
        AND: [
          { deletedAt: null },
          // 里层是租户扩展算出来的 AND：调用方的 where 被它锁死
          { AND: [{ tenantId: 't1' }, { name: 'x' }] },
        ],
      },
    })
  })

  it('⑨ 调用方硬写 tenantId 也穿不过去，软删条件与租户条件同时生效', async () => {
    await modelOf(service.tenant, 'goods').findMany({ where: { tenantId: 'other' } })

    expect(controls.callsOf('Goods', 'findMany')[0]?.args).toEqual({
      where: {
        AND: [{ deletedAt: null }, { AND: [{ tenantId: 't1' }, { tenantId: 'other' }] }],
      },
    })
  })

  it('⑨ create 三个扩展依次生效：注入 tenantId + 填 ULID（软删不碰写入）', async () => {
    await modelOf(service.tenant, 'goods').create({ data: { name: 'x' } })

    const data = (controls.callsOf('Goods', 'create')[0]?.args as { data: Record<string, unknown> })
      .data
    expect(data.tenantId).toBe('t1')
    expect(data.name).toBe('x')
    expect(isUlid(String(data.id))).toBe(true)
  })

  it('⑨ delete 被改写成 update，且改写出来的 update 仍然先验归属', async () => {
    controls.on('Goods', 'findUnique', { tenantId: 't1' })

    await modelOf(service.tenant, 'goods').delete({ where: { id: 'g1' } })

    // **一次** findUnique：软删的 `delete` 是 model 组件的覆盖实现，它直接换成 `update`，
    // 租户扩展的 query 钩子看到的就只有那个 `update`（并对它跑归属探针）。
    //
    // 旧实现是 query 钩子 + 回调外层客户端，租户扩展会先看到 `delete`（探针一次）
    // 再看到改写出来的 `update`（探针第二次）——所以这里以前是两次。
    // 换成 model 组件是为了修「事务内软删脱离事务」那个 bug（见 soft-delete.ts 文件头），
    // 少一次探针是顺带的好处，隔离强度没有变化：真正写库的那个 `update` 照样被验了。
    expect(controls.calls.map((c) => `${c.model}.${c.operation}`)).toEqual([
      'Goods.findUnique',
      'Goods.update',
    ])
    expect(controls.callsOf('Goods', 'update')[0]?.args).toEqual({
      where: { id: 'g1' },
      data: { deletedAt: NOW },
    })
    expect(controls.callsOf('Goods', 'delete')).toHaveLength(0)
  })

  it('⑨ 跨租户 delete 仍然被挡住（归属探针发现记录属于别家）', async () => {
    // 探针查到的记录属于别的租户 → 改写出来的 update 在执行前就被拦下。
    controls.on('Goods', 'findUnique', { tenantId: 'other-tenant' })

    await expect(modelOf(service.tenant, 'goods').delete({ where: { id: 'g1' } })).rejects.toThrow(
      /不属于当前租户/,
    )

    // 一条写语句都没发出去。
    expect(controls.callsOf('Goods', 'update')).toHaveLength(0)
    expect(controls.callsOf('Goods', 'delete')).toHaveLength(0)
  })

  it('⑨ 不在软删名单里的模型，delete 原样落库且仍然经过租户扩展', async () => {
    // `Staff` 没登记进 softDeleteModels（本 spec 的夹具里只有 Goods），
    // 它的 delete 走 `$parent`——那是**叠加软删之前**的客户端，也就是 base + tenant。
    controls.on('Staff', 'findUnique', { tenantId: 't1' })

    await modelOf(service.tenant, 'staff').delete({ where: { id: 's1' } })

    expect(controls.calls.map((c) => `${c.model}.${c.operation}`)).toEqual([
      'Staff.findUnique',
      'Staff.delete',
    ])
  })

  it('无租户上下文时 tenant 句柄直接抛，一条查询都发不出去', async () => {
    tenantId = undefined

    let caught: unknown
    await modelOf(service.tenant, 'goods')
      .findMany()
      .catch((error: unknown) => {
        caught = error
      })

    expect(isTenantScopeError(caught, 'NO_CONTEXT')).toBe(true)
    expect(controls.calls).toHaveLength(0)
  })
})

describe('PrismaService 的 raw 句柄', () => {
  it('⑩ 不注入 tenantId，但软删过滤与 ULID 填充照常生效', async () => {
    tenantId = undefined // 证明 raw 完全不看租户上下文

    await modelOf(service.raw, 'goods').findMany({ where: { name: 'x' } })
    await modelOf(service.raw, 'goods').create({ data: { name: 'x' } })

    expect(controls.callsOf('Goods', 'findMany')[0]?.args).toEqual({
      where: { AND: [{ deletedAt: null }, { name: 'x' }] },
    })

    const data = (controls.callsOf('Goods', 'create')[0]?.args as { data: Record<string, unknown> })
      .data
    expect(data).not.toHaveProperty('tenantId')
    expect(isUlid(String(data.id))).toBe(true)
  })

  it('⑩ hardDelete 走完全裸的 base 客户端：既不软删改写也不注入租户', async () => {
    tenantId = undefined

    await service.hardDelete('Goods', { where: { id: 'g1' } })

    expect(controls.callsOf('Goods', 'delete')[0]?.args).toEqual({ where: { id: 'g1' } })
    expect(controls.callsOf('Goods', 'update')).toHaveLength(0)
  })
})

describe('PrismaService 的 db 健康探针', () => {
  it('⑫ $queryRaw 正常时返回 up', async () => {
    await expect(service.healthIndicator.check()).resolves.toBe('up')
    expect(controls.callsOf('$queryRaw')).toHaveLength(1)
  })

  it('⑫ $queryRaw 抛错时返回 down（不把异常抛给 /health）', async () => {
    controls.onQueryRaw(() => {
      throw new Error('connection refused')
    })

    await expect(service.healthIndicator.check()).resolves.toBe('down')
  })

  it('⑫ $queryRaw 卡住超过超时时间时返回 down', async () => {
    const fake = createFakePrisma()
    fake.controls.onQueryRaw(() => new Promise(() => {}))
    const slow = new PrismaService(fake.client, {
      ...baseOptions(fake.client),
      healthCheckTimeoutMs: 10,
    })

    await expect(slow.healthIndicator.check()).resolves.toBe('down')
  })

  it('onModuleInit 把探针注册进 HealthRegistry', async () => {
    const fake = createFakePrisma()
    const registry = new HealthRegistry()
    const withHealth = new PrismaService(fake.client, baseOptions(fake.client), registry)

    await withHealth.onModuleInit()

    expect(registry.list().map((i) => i.name)).toEqual(['db'])
  })
})

describe('PrismaService 的事务与乐观锁', () => {
  it('$transaction 内的调用仍然走全部三个扩展', async () => {
    await service.$transaction(async (tx) =>
      modelOf(tx as object, 'goods').findMany({ where: { a: 1 } }),
    )

    expect(controls.callsOf('Goods', 'findMany')[0]?.args).toEqual({
      where: { AND: [{ deletedAt: null }, { AND: [{ tenantId: 't1' }, { a: 1 }] }] },
    })
  })

  it('updateWithVersion 走 tenant 句柄，where 同时带上租户条件与版本条件', async () => {
    controls.on('Goods', 'updateMany', { count: 1 })

    await service.updateWithVersion('Goods', {
      where: { id: 'g1' },
      expectedVersion: 2,
      data: { name: 'x' },
    })

    expect(controls.callsOf('Goods', 'updateMany')[0]?.args).toEqual({
      where: { AND: [{ tenantId: 't1' }, { id: 'g1', version: 2 }] },
      data: { name: 'x', version: { increment: 1 } },
    })
  })

  it('updateWithVersion 命中 0 行时抛 OptimisticLockError', async () => {
    controls.on('Goods', 'updateMany', { count: 0 })

    await expect(
      service.updateWithVersion('Goods', { where: { id: 'g1' }, expectedVersion: 2, data: {} }),
    ).rejects.toBeInstanceOf(OptimisticLockError)
  })
})

describe('PrismaModule', () => {
  it('forRoot 能装配出 PrismaService 与 RawPrismaService，且 raw 句柄是同一个对象', async () => {
    const fake = createFakePrisma()
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule.forRoot(baseOptions(fake.client))],
    }).compile()

    const prisma = moduleRef.get(PrismaService)
    const raw = moduleRef.get(RawPrismaService)

    expect(raw.client).toBe(prisma.raw)
    await moduleRef.close()
  })

  it('forRootAsync 支持从工厂算选项', async () => {
    const fake = createFakePrisma()
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule.forRootAsync({ useFactory: () => baseOptions(fake.client) })],
    }).compile()

    expect(moduleRef.get(PrismaService)).toBeInstanceOf(PrismaService)
    await moduleRef.close()
  })
})
