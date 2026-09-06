/**
 * 一套最小的权限点 / 菜单夹具，本包与下游的测试共用。
 *
 * 刻意做小（两个模块、六个权限点、一棵两层菜单树）：夹具一大，断言就会开始依赖
 * 「第 7 个菜单项恰好排在第 3 位」这种和被测行为无关的巧合。
 *
 * @packageDocumentation
 */

import { defineMenus, definePermissions, type MenuDef } from '@taizan/contracts'
import type { AuthPrincipal } from '@taizan/nest-auth'
import type { SubtreeResolver } from '../data-scope.interceptor'

/** 夹具权限点表。 */
export function fixturePermissions(): Readonly<
  Record<string, { module: string; name: string; type: 'API' | 'BUTTON' }>
> {
  return definePermissions({
    'goods:list': { module: '商品', name: '查看商品', type: 'API' },
    'goods:write': { module: '商品', name: '新增/编辑商品', type: 'API' },
    'goods:export': { module: '商品', name: '导出商品', type: 'BUTTON' },
    'order:list': { module: '订单', name: '查看订单', type: 'API' },
    'order:refund': { module: '订单', name: '订单退款', type: 'API' },
    'coupon:list': { module: '营销', name: '查看优惠券', type: 'API' },
  })
}

/**
 * 夹具菜单树。
 *
 * - `goods` 目录下三个节点，其中 `goods.export` 是 `BUTTON`；
 * - `order` 目录带 `featureKey: 'order'`；
 * - `coupon` 是一个**整棵树都带 featureKey** 的营销模块，用来验证
 *   `features: []` 时它整块消失、`features: null` 时全保留。
 */
export function fixtureMenus(): readonly MenuDef[] {
  return defineMenus([
    {
      key: 'goods',
      title: '商品',
      icon: 'ShopOutlined',
      type: 'DIR',
      side: 'ADMIN',
      sort: 10,
      children: [
        {
          key: 'goods.list',
          title: '商品列表',
          path: '/goods',
          componentKey: 'GoodsList',
          type: 'MENU',
          side: 'ADMIN',
          permission: 'goods:list',
          sort: 10,
        },
        {
          key: 'goods.create',
          title: '新增商品',
          path: '/goods/create',
          componentKey: 'GoodsCreate',
          type: 'MENU',
          side: 'ADMIN',
          permission: 'goods:write',
          sort: 20,
        },
        {
          key: 'goods.export',
          title: '导出商品',
          type: 'BUTTON',
          side: 'ADMIN',
          permission: 'goods:export',
          sort: 30,
        },
      ],
    },
    {
      key: 'order',
      title: '订单',
      type: 'DIR',
      side: 'ADMIN',
      sort: 20,
      children: [
        {
          key: 'order.list',
          title: '订单列表',
          path: '/orders',
          componentKey: 'OrderList',
          type: 'MENU',
          side: 'ADMIN',
          permission: 'order:list',
          featureKey: 'order',
          sort: 10,
        },
      ],
    },
    {
      key: 'coupon',
      title: '优惠券',
      path: '/coupons',
      componentKey: 'CouponList',
      type: 'MENU',
      side: 'ADMIN',
      permission: 'coupon:list',
      featureKey: 'marketing',
      sort: 30,
    },
    {
      key: 'platform.tenant',
      title: '租户管理',
      path: '/tenants',
      componentKey: 'TenantList',
      type: 'MENU',
      side: 'PLATFORM',
      sort: 10,
    },
  ])
}

/** 一条夹具角色。 */
export interface FixtureRole {
  id: string
  permissionCodes: string[]
}

/**
 * 造一批 `Role` 行，可直接喂给 `createFakePrisma().controls.on('Role', 'findMany', ...)`。
 *
 * 返回的是一个**按 `where.id.in` 过滤**的函数，而不是一个静态数组：守卫只查它要的
 * 那几个角色，静态数组会让「只查了缺失的角色」这条断言失效。
 */
export function makeRoleRows(roles: readonly FixtureRole[]) {
  return (call: { args: unknown }): FixtureRole[] => {
    const args = call.args as { where?: { id?: { in?: string[] } } } | undefined
    const wanted = args?.where?.id?.in
    if (wanted === undefined) return [...roles]
    return roles.filter((role) => wanted.includes(role.id))
  }
}

/** 固定返回一批组织 id 的 `SUB_TREE` 解析器。 */
export class FakeSubtreeResolver implements SubtreeResolver {
  /** 被调用的次数。 */
  calls = 0

  constructor(private readonly ids: string[] = []) {}

  resolve(_principal: AuthPrincipal): string[] {
    this.calls += 1
    return [...this.ids]
  }
}
