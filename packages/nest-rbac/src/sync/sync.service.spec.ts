/**
 * T1-2 验收用例⑨：同步命令幂等（跑两次，发出去的 upsert 调用集合完全一致）。
 */

import { definePermissions } from '@taizan/contracts'
import {
  createFakePrisma,
  type FakePrismaControls,
  type RecordedCall,
} from '@taizan/nest-prisma/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { MenuRegistry, PermissionRegistry } from '../registry'
import { fixtureMenus, fixturePermissions } from '../testing/fixtures'
import { mirrorId } from './mirror-id'
import { buildMenuRows, buildPermissionRows, RbacSyncService } from './sync.service'

let controls: FakePrismaControls
let prisma: { raw: object }
let permissions: PermissionRegistry
let menus: MenuRegistry

/** DB 里已有的行（`findMany({ select: { code } })` 的返回）。 */
function seedExisting(model: 'Permission' | 'Menu', keys: string[], field: 'code' | 'key'): void {
  controls.on(
    model,
    'findMany',
    keys.map((k) => ({ [field]: k })),
  )
}

function service(): RbacSyncService {
  return new RbacSyncService(prisma, permissions, menus)
}

beforeEach(() => {
  const fake = createFakePrisma()
  controls = fake.controls
  prisma = { raw: fake.client }
  permissions = new PermissionRegistry([fixturePermissions()])
  menus = new MenuRegistry(permissions, [fixtureMenus()])
  seedExisting('Permission', [], 'code')
  seedExisting('Menu', [], 'key')
})

describe('buildPermissionRows / buildMenuRows（纯函数）', () => {
  it('权限点行带确定性主键、按注册顺序排 sort', () => {
    const rows = buildPermissionRows(permissions)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({
      id: mirrorId('Permission', 'goods:list'),
      code: 'goods:list',
      module: '商品',
      name: '查看商品',
      type: 'API',
      sort: 0,
    })
  })

  it('菜单行按 key 串父子关系，缺省字段落成 null', () => {
    const rows = buildMenuRows(menus)
    const list = rows.find((row) => row.key === 'goods.list')
    expect(list).toEqual({
      id: mirrorId('Menu', 'goods.list'),
      key: 'goods.list',
      parentKey: 'goods',
      title: '商品列表',
      icon: null,
      path: '/goods',
      componentKey: 'GoodsList',
      type: 'MENU',
      permission: 'goods:list',
      featureKey: null,
      sort: 10,
      side: 'ADMIN',
    })
    expect(rows.find((row) => row.key === 'goods')?.parentKey).toBeNull()
  })

  it('两侧的菜单都会被镜像（Menu 表按 side 区分，不是两张表）', () => {
    expect(buildMenuRows(menus).map((row) => row.side)).toContain('PLATFORM')
  })
})

describe('mirrorId', () => {
  it('确定性：同样的输入永远给同一个 id', () => {
    expect(mirrorId('Permission', 'goods:list')).toBe(mirrorId('Permission', 'goods:list'))
  })

  it('26 位、Crockford base32（对齐 @db.VarChar(26)）', () => {
    expect(mirrorId('Menu', 'goods')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('表名参与哈希：两张表的同名 key 不会撞', () => {
    expect(mirrorId('Permission', 'x')).not.toBe(mirrorId('Menu', 'x'))
  })
})

describe('用例⑨：幂等', () => {
  /** 只留下写操作，读操作（findMany）不参与幂等比对。 */
  function writeCalls(calls: readonly RecordedCall[]): RecordedCall[] {
    return calls.filter((call) => call.operation !== 'findMany')
  }

  it('权限点同步跑两次，upsert 调用集合逐字节一致', async () => {
    await service().syncPermissionsToDb()
    const first = JSON.stringify(writeCalls(controls.callsOf('Permission')))
    controls.reset()
    seedExisting('Permission', permissions.codes(), 'code')

    await service().syncPermissionsToDb()
    const second = JSON.stringify(writeCalls(controls.callsOf('Permission')))
    expect(second).toBe(first)
  })

  it('菜单同步跑两次，upsert 调用集合逐字节一致', async () => {
    await service().syncMenusToDb()
    const first = JSON.stringify(writeCalls(controls.callsOf('Menu')))
    controls.reset()
    seedExisting(
      'Menu',
      menus.flatten().map((item) => item.def.key),
      'key',
    )

    await service().syncMenusToDb()
    expect(JSON.stringify(writeCalls(controls.callsOf('Menu')))).toBe(first)
  })

  it('upsert 的 update 分支不带 id（主键发下去就不再变）', async () => {
    await service().syncPermissionsToDb()
    const call = controls.callsOf('Permission', 'upsert')[0]
    const args = call?.args as { create: Record<string, unknown>; update: Record<string, unknown> }
    expect(args.create).toHaveProperty('id')
    expect(args.update).not.toHaveProperty('id')
  })

  it('走 raw 句柄（平台域镜像表没有 tenantId，走 tenant 会被扩展拦下）', async () => {
    await service().syncPermissionsToDb()
    const call = controls.callsOf('Permission', 'upsert')[0]
    // 替身没有装租户扩展，这里断言的是「args 里没有被注入任何租户条件」。
    expect(JSON.stringify(call?.args)).not.toContain('tenantId')
  })
})

describe('多余行：删除（不是标记）', () => {
  it('注册表里没有的行被 deleteMany 掉', async () => {
    seedExisting('Permission', [...permissions.codes(), 'legacy:code'], 'code')
    const report = await service().syncPermissionsToDb()
    expect(report.deleted).toBe(1)
    expect(report.deletedKeys).toEqual(['legacy:code'])
    expect(controls.callsOf('Permission', 'deleteMany')[0]?.args).toEqual({
      where: { code: { in: ['legacy:code'] } },
    })
  })

  it('没有多余行时不发 deleteMany（少一条空 SQL）', async () => {
    seedExisting('Permission', permissions.codes(), 'code')
    await service().syncPermissionsToDb()
    expect(controls.callsOf('Permission', 'deleteMany')).toHaveLength(0)
  })

  it('熔断：一次要删掉超过一半的行时抛错（防注册表被误清空）', async () => {
    permissions = new PermissionRegistry([
      definePermissions({ 'goods:list': { module: '商品', name: '查看', type: 'API' } }),
    ])
    menus = new MenuRegistry(permissions)
    seedExisting('Permission', ['goods:list', 'a:b', 'c:d', 'e:f'], 'code')
    await expect(service().syncPermissionsToDb()).rejects.toThrow(/熔断/)
  })

  it('maxDeleteRatio: 1 关掉熔断', async () => {
    permissions = new PermissionRegistry()
    menus = new MenuRegistry(permissions)
    seedExisting('Permission', ['a:b', 'c:d'], 'code')
    const report = await service().syncPermissionsToDb({ maxDeleteRatio: 1 })
    expect(report.deleted).toBe(2)
  })

  it('首次初始化（库里一行都没有）不触发熔断', async () => {
    seedExisting('Permission', [], 'code')
    await expect(service().syncPermissionsToDb()).resolves.toMatchObject({ deleted: 0 })
  })
})

describe('dry-run', () => {
  it('只算不写：一条 upsert / deleteMany 都不发', async () => {
    seedExisting('Permission', [...permissions.codes(), 'legacy:code'], 'code')
    const report = await service().syncPermissionsToDb({ dryRun: true })
    expect(report).toMatchObject({ upserted: 6, deleted: 1, dryRun: true })
    expect(controls.callsOf('Permission', 'upsert')).toHaveLength(0)
    expect(controls.callsOf('Permission', 'deleteMany')).toHaveLength(0)
  })
})

describe('syncAll', () => {
  it('两张表一起同步', async () => {
    const report = await service().syncAll()
    expect(report.permissions.upserted).toBe(6)
    expect(report.menus.upserted).toBe(8)
  })
})
