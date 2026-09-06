/**
 * 三张注册表的行为，以及 T1-2 验收用例③「未注册的权限点在装饰器/注册时抛错」的
 * 「注册时」那一半（「装饰器」那一半在 `decorators/require-permission.spec.ts`）。
 */

import { defineMenus, definePermissions } from '@taizan/contracts'
import { describe, expect, it } from 'vitest'
import { FeatureRegistry, MenuRegistry, PermissionRegistry } from './registry'
import { fixtureMenus, fixturePermissions } from './testing/fixtures'

const GOODS = definePermissions({
  'goods:list': { module: '商品', name: '查看商品', type: 'API' },
  'goods:write': { module: '商品', name: '编辑商品', type: 'API' },
})

const ORDER = definePermissions({
  'order:list': { module: '订单', name: '查看订单', type: 'API' },
})

describe('PermissionRegistry', () => {
  it('合并多个模块的 definePermissions 结果', () => {
    const registry = new PermissionRegistry([GOODS, ORDER])
    expect(registry.size).toBe(3)
    expect(registry.codes()).toEqual(['goods:list', 'goods:write', 'order:list'])
  })

  it('all() 把 code 展开进对象，可直接喂给同步命令', () => {
    const registry = new PermissionRegistry([ORDER])
    expect(registry.all()).toEqual([
      { code: 'order:list', module: '订单', name: '查看订单', type: 'API' },
    ])
  })

  it('has / get 按 code 查', () => {
    const registry = new PermissionRegistry([GOODS])
    expect(registry.has('goods:list')).toBe(true)
    expect(registry.has('goods:nope')).toBe(false)
    expect(registry.get('goods:write')?.name).toBe('编辑商品')
    expect(registry.get('goods:nope')).toBeUndefined()
  })

  it('重复 code 抛错，并指出是哪两批撞的', () => {
    const registry = new PermissionRegistry()
    registry.register(GOODS, '商品模块')
    expect(() => registry.register(GOODS, '库存模块')).toThrow(/goods:list.*商品模块.*库存模块/s)
  })

  it('空注册表是合法的（新项目还没写任何权限点）', () => {
    expect(new PermissionRegistry().codes()).toEqual([])
  })
})

describe('MenuRegistry', () => {
  function registry(): MenuRegistry {
    return new MenuRegistry(new PermissionRegistry([fixturePermissions()]), [fixtureMenus()])
  }

  it('bySide 只给这一侧的根节点', () => {
    const keys = registry()
      .bySide('ADMIN')
      .map((def) => def.key)
    expect(keys).toEqual(['goods', 'order', 'coupon'])
    expect(
      registry()
        .bySide('PLATFORM')
        .map((def) => def.key),
    ).toEqual(['platform.tenant'])
  })

  it('flatten 先序遍历并带上 parentKey（同步命令按它写 Menu.parentKey）', () => {
    const flat = registry().flatten()
    expect(flat.map((item) => item.def.key)).toEqual([
      'goods',
      'goods.list',
      'goods.create',
      'goods.export',
      'order',
      'order.list',
      'coupon',
      'platform.tenant',
    ])
    expect(flat.find((item) => item.def.key === 'goods.list')?.parentKey).toBe('goods')
    expect(flat.find((item) => item.def.key === 'goods')?.parentKey).toBeUndefined()
  })

  it('has / get 覆盖所有层级，不只是根节点', () => {
    expect(registry().has('goods.export')).toBe(true)
    expect(registry().get('goods.list')?.componentKey).toBe('GoodsList')
  })

  it('跨批次的 key 重复抛错（defineMenus 只看得见自己那一批）', () => {
    const permissions = new PermissionRegistry([fixturePermissions()])
    const menus = new MenuRegistry(permissions, [fixtureMenus()])
    const dup = defineMenus([{ key: 'coupon', title: '又一个优惠券', type: 'MENU', side: 'ADMIN' }])
    expect(() => menus.register(dup, '营销模块')).toThrow(/coupon.*重复注册/)
  })

  it('用例③：菜单引用未注册的权限点时在注册期抛错', () => {
    const permissions = new PermissionRegistry([fixturePermissions()])
    const bad = defineMenus([
      { key: 'ghost', title: '幽灵', type: 'MENU', side: 'ADMIN', permission: 'ghost:code' },
    ])
    expect(() => new MenuRegistry(permissions, [bad])).toThrow(/ghost:code/)
  })

  it('用例③：或表达式里任意一个 code 未注册也抛错', () => {
    const permissions = new PermissionRegistry([fixturePermissions()])
    const bad = defineMenus([
      {
        key: 'half',
        title: '半个',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'goods:list|ghost:code',
      },
    ])
    expect(() => new MenuRegistry(permissions, [bad])).toThrow(/ghost:code/)
  })

  it('featureKey 不校验：允许菜单先写好、套餐功能项晚一步上线', () => {
    const permissions = new PermissionRegistry([fixturePermissions()])
    const menus = defineMenus([
      {
        key: 'future',
        title: '未来功能',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'goods:list',
        featureKey: '还没登记的功能',
      },
    ])
    expect(() => new MenuRegistry(permissions, [menus])).not.toThrow()
  })
})

describe('FeatureRegistry（只存不判）', () => {
  const COUPON = { key: 'coupon', name: '优惠券', writeOnly: true, pathPrefixes: ['/api/admin/c'] }

  it('存取与 keys', () => {
    const registry = new FeatureRegistry([COUPON])
    expect(registry.size).toBe(1)
    expect(registry.keys()).toEqual(['coupon'])
    expect(registry.get('coupon')?.writeOnly).toBe(true)
    expect(registry.has('nope')).toBe(false)
  })

  it('重复 key 抛错（同一个 key 两套 pathPrefixes，闸门按哪套走说不清）', () => {
    const registry = new FeatureRegistry([COUPON])
    expect(() => registry.register([{ ...COUPON, pathPrefixes: ['/api/admin/x'] }])).toThrow(
      /coupon.*重复注册/,
    )
  })

  it('不做任何判定：writeOnly / pathPrefixes 原样存着交给 billing-rules', () => {
    const registry = new FeatureRegistry([COUPON])
    expect(registry.all()).toEqual([COUPON])
  })
})
