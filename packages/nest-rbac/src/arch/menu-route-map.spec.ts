/**
 * T1-2 验收用例⑪ / 蓝图 §8 spec 7 的**样板**：`menu-route-map.spec.ts`。
 *
 * `apps/admin` / `apps/platform` 侧的 spec 直接 import `verifyMenuComponentMap`，
 * 把自己的 `component-map.ts` 传进来即可，不要在下游再抄一份实现。
 */

import { defineMenus } from '@taizan/contracts'
import { describe, expect, it } from 'vitest'
import { fixtureMenus, fixturePermissions } from '../testing/fixtures'
import { verifyMenuComponentMap } from './menu-component-map'

/** 一份「前端 component-map.ts」的样子：key → 组件（这里用占位符）。 */
const COMPONENT_MAP = {
  GoodsList: () => null,
  GoodsCreate: () => null,
  OrderList: () => null,
  CouponList: () => null,
  TenantList: () => null,
}

describe('verifyMenuComponentMap', () => {
  it('全部对得上时零违规', () => {
    const report = verifyMenuComponentMap(fixtureMenus(), COMPONENT_MAP, {
      permissions: fixturePermissions(),
    })
    expect(report.violations).toEqual([])
  })

  it('列出菜单用到的全部 componentKey', () => {
    const report = verifyMenuComponentMap(fixtureMenus(), COMPONENT_MAP)
    expect(report.usedComponentKeys).toEqual([
      'CouponList',
      'GoodsCreate',
      'GoodsList',
      'OrderList',
      'TenantList',
    ])
  })

  it('componentKey 在前端没有映射 → missing-component（用户点进去白屏）', () => {
    const { GoodsList: _drop, ...partial } = COMPONENT_MAP
    const report = verifyMenuComponentMap(fixtureMenus(), partial)
    const violation = report.violations.find((v) => v.rule === 'missing-component')
    expect(violation?.menuKey).toBe('goods.list')
    expect(violation?.message).toContain('白屏')
  })

  it('allowMissing 白名单放行（前端还没提交的新页面）', () => {
    const { GoodsList: _drop, ...partial } = COMPONENT_MAP
    const report = verifyMenuComponentMap(fixtureMenus(), partial, {
      allowMissing: ['GoodsList'],
    })
    expect(report.violations).toEqual([])
  })

  it('有 path 没 componentKey → path-without-component', () => {
    const menus = defineMenus([
      { key: 'orphan', title: '孤儿页', path: '/orphan', type: 'MENU', side: 'ADMIN' },
    ])
    const report = verifyMenuComponentMap(menus, COMPONENT_MAP)
    expect(report.violations.map((v) => v.rule)).toEqual(['path-without-component'])
  })

  it('菜单引用未注册的权限点 → unknown-permission', () => {
    const menus = defineMenus([
      {
        key: 'ghosty',
        title: '幽灵',
        path: '/g',
        componentKey: 'GoodsList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'ghost:code',
      },
    ])
    const report = verifyMenuComponentMap(menus, COMPONENT_MAP, {
      permissions: fixturePermissions(),
    })
    expect(report.violations.map((v) => v.rule)).toEqual(['unknown-permission'])
  })

  it('不传 permissions 时跳过权限点检查（前端侧 spec 可能拿不到服务端注册表）', () => {
    const menus = defineMenus([
      {
        key: 'ghosty',
        title: '幽灵',
        path: '/g',
        componentKey: 'GoodsList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'ghost:code',
      },
    ])
    expect(verifyMenuComponentMap(menus, COMPONENT_MAP).violations).toEqual([])
  })

  it('DIR 与 BUTTON 没有 componentKey 不算违规（它们本来就不进路由）', () => {
    const report = verifyMenuComponentMap(fixtureMenus(), COMPONENT_MAP)
    expect(report.violations).toEqual([])
  })

  it('反向的「map 里有、菜单里没有」只提示不报错（登录页、404 是正常的）', () => {
    const report = verifyMenuComponentMap(fixtureMenus(), {
      ...COMPONENT_MAP,
      LoginPage: () => null,
    })
    expect(report.unusedComponentKeys).toEqual(['LoginPage'])
    expect(report.violations).toEqual([])
  })

  it('componentMap 也可以传一个 key 数组', () => {
    const report = verifyMenuComponentMap(fixtureMenus(), Object.keys(COMPONENT_MAP))
    expect(report.violations).toEqual([])
  })
})
