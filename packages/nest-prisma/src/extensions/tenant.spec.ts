import { describe, expect, it } from 'vitest'
import { isTenantScopeError } from '@taizan/tenant-scope'
import { createFakePrisma, modelOf, type FakePrismaClient } from '../testing/fake-prisma-client'
import { createTenantExtension } from './tenant'

const REGISTERED = new Set(['Goods'])

// 刻意不给默认值：`setup(undefined)` 会落回默认值，那是最容易写错的一处。
function setup(tenantId: string | undefined): {
  tenant: FakePrismaClient
  controls: ReturnType<typeof createFakePrisma>['controls']
} {
  const { client, controls } = createFakePrisma()
  const tenant = client.$extends(
    createTenantExtension({
      getTenantId: () => tenantId,
      registered: REGISTERED,
      // 探针用未叠加扩展的原始客户端，见 TenantExtensionDeps.raw 的说明。
      raw: client,
    }),
  )
  return { tenant, controls }
}

/** 断言 promise 以某个 reason 的 TenantScopeError 失败。 */
async function expectScopeError(promise: Promise<unknown>, reason: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  if (!isTenantScopeError(caught)) {
    throw new Error(`期望抛 TenantScopeError(${reason})，实际拿到 ${String(caught)}`)
  }
  expect(caught.reason).toBe(reason)
}

describe('createTenantExtension', () => {
  it('① 没有租户上下文时，租户域模型的读操作直接抛 NO_CONTEXT，绝不退化成查全表', async () => {
    const { tenant, controls } = setup(undefined)

    await expectScopeError(modelOf(tenant, 'goods').findMany(), 'NO_CONTEXT')
    // 关键断言：没有任何查询真的发出去。老项目那版是 `return query(args)` 放行。
    expect(controls.calls).toHaveLength(0)
  })

  it('① 空串租户 id 同样抛 NO_CONTEXT（执行层不做「有值即可」的宽松判断）', async () => {
    const { tenant } = setup('')
    await expectScopeError(modelOf(tenant, 'goods').count(), 'NO_CONTEXT')
  })

  it('② findMany 的 where 被 AND 包裹，调用方自己传的 tenantId 覆盖不掉', async () => {
    const { tenant, controls } = setup('t1')

    await modelOf(tenant, 'goods').findMany({ where: { tenantId: 'other', name: 'x' } })

    expect(controls.callsOf('Goods', 'findMany')[0]?.args).toEqual({
      // 两个条件同时成立 → 必然空集，而不是「查到了别人的数据」。
      where: { AND: [{ tenantId: 't1' }, { tenantId: 'other', name: 'x' }] },
    })
  })

  it('② 非租户域模型原样放行（平台域表要能跨租户查）', async () => {
    const { tenant, controls } = setup('t1')

    await modelOf(tenant, 'platformAdmin').findMany({ where: { phone: '1' } })

    expect(controls.callsOf('PlatformAdmin', 'findMany')[0]?.args).toEqual({
      where: { phone: '1' },
    })
  })

  it('③ upsert 的 create 分支注入 tenantId，且执行前先按唯一键查一次归属', async () => {
    const { tenant, controls } = setup('t1')
    controls.on('Goods', 'findUnique', null) // 记录不存在 → 走 create 分支

    await modelOf(tenant, 'goods').upsert({
      where: { id: 'g1' },
      create: { name: '新商品' },
      update: { name: '改名' },
    })

    // 顺序本身就是断言：先探针，后 upsert。
    expect(controls.calls.map((c) => `${c.model}.${c.operation}`)).toEqual([
      'Goods.findUnique',
      'Goods.upsert',
    ])
    expect(controls.callsOf('Goods', 'findUnique')[0]?.args).toEqual({
      where: { id: 'g1' },
      select: { tenantId: true },
    })
    expect(controls.callsOf('Goods', 'upsert')[0]?.args).toEqual({
      where: { id: 'g1' },
      create: { name: '新商品', tenantId: 't1' },
      update: { name: '改名' },
    })
  })

  it('③ 归属探针发现记录属于别的租户时，upsert 根本不会执行', async () => {
    const { tenant, controls } = setup('t1')
    controls.on('Goods', 'findUnique', { tenantId: 'other' })

    await expectScopeError(
      modelOf(tenant, 'goods').upsert({ where: { id: 'g1' }, create: {}, update: {} }),
      'FOREIGN_RESULT',
    )
    expect(controls.callsOf('Goods', 'upsert')).toHaveLength(0)
  })

  it('③ update 同样先验归属（delete 的路径见 soft-delete.spec.ts）', async () => {
    const { tenant, controls } = setup('t1')
    controls.on('Goods', 'findUnique', { tenantId: 't1' })

    await modelOf(tenant, 'goods').update({ where: { id: 'g1' }, data: { name: 'x' } })

    expect(controls.calls.map((c) => c.operation)).toEqual(['findUnique', 'update'])
  })

  it('④ findUnique 命中外租户返回 null，findUniqueOrThrow 抛 FOREIGN_RESULT', async () => {
    const { tenant, controls } = setup('t1')
    controls.on('Goods', 'findUnique', { id: 'g1', tenantId: 'other' })
    controls.on('Goods', 'findUniqueOrThrow', { id: 'g1', tenantId: 'other' })

    await expect(modelOf(tenant, 'goods').findUnique({ where: { id: 'g1' } })).resolves.toBeNull()
    await expectScopeError(
      modelOf(tenant, 'goods').findUniqueOrThrow({ where: { id: 'g1' } }),
      'FOREIGN_RESULT',
    )
  })

  it('④ findUnique 自带 select 时会被补上 tenantId，否则归属校验永远判失败', async () => {
    const { tenant, controls } = setup('t1')
    controls.on('Goods', 'findUnique', { id: 'g1', tenantId: 't1' })

    await modelOf(tenant, 'goods').findUnique({ where: { id: 'g1' }, select: { id: true } })

    expect(controls.callsOf('Goods', 'findUnique')[0]?.args).toEqual({
      where: { id: 'g1' },
      select: { id: true, tenantId: true },
    })
  })

  it('④ 本租户的记录原样返回', async () => {
    const { tenant, controls } = setup('t1')
    controls.on('Goods', 'findUnique', { id: 'g1', tenantId: 't1' })

    await expect(modelOf(tenant, 'goods').findUnique({ where: { id: 'g1' } })).resolves.toEqual({
      id: 'g1',
      tenantId: 't1',
    })
  })

  it('create 注入 tenantId；调用方写别的租户时抛 TENANT_ID_CONFLICT', async () => {
    const { tenant, controls } = setup('t1')

    await modelOf(tenant, 'goods').create({ data: { name: 'x' } })
    expect(controls.callsOf('Goods', 'create')[0]?.args).toEqual({
      data: { name: 'x', tenantId: 't1' },
    })

    await expectScopeError(
      modelOf(tenant, 'goods').create({ data: { name: 'x', tenantId: 'other' } }),
      'TENANT_ID_CONFLICT',
    )
  })

  it('⑪ 决策函数不认识的操作名一律抛 UNKNOWN_OPERATION（证明执行层没有绕开决策函数）', async () => {
    const { tenant, controls } = setup('t1')

    // 假装 Prisma 某天多出一个新操作：执行层必须失败关闭，而不是放行。
    await expectScopeError(
      modelOf(tenant, 'goods').findManyAndCount!({ where: {} }),
      'UNKNOWN_OPERATION',
    )
    expect(controls.calls).toHaveLength(0)
  })

  it('⑪ 未知操作落在非租户域模型上时放行（隔离只管租户域表）', async () => {
    const { tenant, controls } = setup('t1')

    await modelOf(tenant, 'platformAdmin').findManyAndCount!({ where: {} })

    expect(controls.callsOf('PlatformAdmin', 'findManyAndCount')).toHaveLength(1)
  })
})
