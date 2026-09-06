import { describe, expect, it } from 'vitest'
import { defineMenus, type MenuDef } from '@taizan/contracts'
import { buildRoutes, flattenMenuKeys, pruneMenus, type PruneMenusContext } from './menu-tree'

const MENUS = defineMenus([
  {
    key: 'goods',
    title: '商品',
    icon: 'ShopOutlined',
    type: 'DIR',
    side: 'ADMIN',
    sort: 20,
    children: [
      {
        key: 'goods.list',
        title: '商品列表',
        path: '/goods',
        componentKey: 'GoodsList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'goods:list',
        featureKey: 'goods',
        sort: 10,
      },
      {
        key: 'goods.export',
        title: '导出商品',
        type: 'BUTTON',
        side: 'ADMIN',
        permission: 'goods:export',
        sort: 20,
      },
    ],
  },
  {
    key: 'order',
    title: '订单',
    type: 'DIR',
    side: 'ADMIN',
    sort: 10,
    children: [
      {
        key: 'order.list',
        title: '订单列表',
        path: '/orders',
        componentKey: 'OrderList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'order:list',
        sort: 10,
      },
    ],
  },
  {
    key: 'platform.tenant',
    title: '租户管理',
    path: '/tenants',
    componentKey: 'TenantList',
    type: 'MENU',
    side: 'PLATFORM',
    permission: 'tenant:list',
    sort: 10,
  },
]) as readonly MenuDef[]

const ALL_GRANTED = new Set(['goods:list', 'goods:export', 'order:list', 'tenant:list'])

function ctx(over: Partial<PruneMenusContext> = {}): PruneMenusContext {
  return { granted: ALL_GRANTED, features: null, side: 'ADMIN', ...over }
}

describe('pruneMenus - 权限裁剪', () => {
  it('权限齐全时保留整棵 ADMIN 树', () => {
    const nodes = pruneMenus(MENUS, ctx())
    expect(nodes.map((n) => n.key)).toEqual(['order', 'goods'])
    expect(nodes[1]?.children?.map((n) => n.key)).toEqual(['goods.list', 'goods.export'])
  })

  it('缺少某个叶子权限时只裁掉那个叶子', () => {
    const nodes = pruneMenus(MENUS, ctx({ granted: new Set(['goods:list', 'order:list']) }))
    expect(nodes.map((n) => n.key)).toEqual(['order', 'goods'])
    expect(nodes[1]?.children?.map((n) => n.key)).toEqual(['goods.list'])
  })

  it('DIR 的子节点被裁光后父目录自动消失', () => {
    const nodes = pruneMenus(MENUS, ctx({ granted: new Set(['order:list']) }))
    expect(nodes.map((n) => n.key)).toEqual(['order'])
  })

  it('权限全空时整棵树为空', () => {
    expect(pruneMenus(MENUS, ctx({ granted: new Set<string>() }))).toEqual([])
  })

  it('多层 DIR 会连锁消失', () => {
    const deep: MenuDef[] = [
      {
        key: 'a',
        title: 'A',
        type: 'DIR',
        side: 'ADMIN',
        children: [
          {
            key: 'a.b',
            title: 'B',
            type: 'DIR',
            side: 'ADMIN',
            children: [
              {
                key: 'a.b.c',
                title: 'C',
                type: 'MENU',
                side: 'ADMIN',
                path: '/c',
                componentKey: 'C',
                permission: 'x:read',
              },
            ],
          },
        ],
      },
    ]
    expect(pruneMenus(deep, ctx({ granted: new Set<string>() }))).toEqual([])
    expect(pruneMenus(deep, ctx({ granted: new Set(['x:read']) })).length).toBe(1)
  })

  it('不带 permission 的节点不受权限裁剪', () => {
    const free: MenuDef[] = [
      { key: 'home', title: '首页', type: 'MENU', side: 'ADMIN', path: '/', componentKey: 'Home' },
    ]
    expect(pruneMenus(free, ctx({ granted: new Set<string>() })).map((n) => n.key)).toEqual([
      'home',
    ])
  })

  it("菜单的 permission 支持 'a|b' 或语义", () => {
    const defs: MenuDef[] = [
      {
        key: 'm',
        title: 'M',
        type: 'MENU',
        side: 'ADMIN',
        path: '/m',
        componentKey: 'M',
        permission: 'goods:write|goods:list',
      },
    ]
    expect(pruneMenus(defs, ctx({ granted: new Set(['goods:list']) })).length).toBe(1)
    expect(pruneMenus(defs, ctx({ granted: new Set(['order:list']) })).length).toBe(0)
  })

  it('菜单的 permission 写通配时抛错', () => {
    const defs: MenuDef[] = [
      {
        key: 'm',
        title: 'M',
        type: 'MENU',
        side: 'ADMIN',
        path: '/m',
        componentKey: 'M',
        permission: 'goods:*',
      },
    ]
    expect(() => pruneMenus(defs, ctx())).toThrow(/通配/)
  })
})

describe('pruneMenus - features 三态', () => {
  it('features 为 null 表示全部可用，不做套餐裁剪', () => {
    const nodes = pruneMenus(MENUS, ctx({ features: null }))
    expect(nodes[1]?.children?.map((n) => n.key)).toContain('goods.list')
  })

  it('features 为 [] 表示一个都不给，带 featureKey 的节点全裁掉', () => {
    const nodes = pruneMenus(MENUS, ctx({ features: [] }))
    // goods.list 带 featureKey 被裁，goods.export 不带 featureKey 仍在
    expect(nodes.find((n) => n.key === 'goods')?.children?.map((n) => n.key)).toEqual([
      'goods.export',
    ])
  })

  it('features 为非空数组时只放行列出的 key', () => {
    expect(
      pruneMenus(MENUS, ctx({ features: ['goods'] }))
        .find((n) => n.key === 'goods')
        ?.children?.map((n) => n.key),
    ).toEqual(['goods.list', 'goods.export'])
    expect(
      pruneMenus(MENUS, ctx({ features: ['marketing'] }))
        .find((n) => n.key === 'goods')
        ?.children?.map((n) => n.key),
    ).toEqual(['goods.export'])
  })

  it('[] 与 null 的结果必须不同（三态不能塌成两态）', () => {
    const withNull = pruneMenus(MENUS, ctx({ features: null }))
    const withEmpty = pruneMenus(MENUS, ctx({ features: [] }))
    expect(withEmpty).not.toEqual(withNull)
  })

  it('featureKey 挂在 DIR 上时整棵子树消失', () => {
    const defs: MenuDef[] = [
      {
        key: 'mk',
        title: '营销',
        type: 'DIR',
        side: 'ADMIN',
        featureKey: 'marketing',
        children: [
          {
            key: 'mk.coupon',
            title: '优惠券',
            type: 'MENU',
            side: 'ADMIN',
            path: '/coupon',
            componentKey: 'Coupon',
          },
        ],
      },
    ]
    expect(pruneMenus(defs, ctx({ features: [] }))).toEqual([])
    expect(pruneMenus(defs, ctx({ features: ['marketing'] })).length).toBe(1)
  })
})

describe('pruneMenus - disabledKeys 与 side', () => {
  it('disabledKeys 命中叶子时移除该叶子', () => {
    const nodes = pruneMenus(MENUS, ctx({ disabledKeys: new Set(['goods.export']) }))
    expect(nodes.find((n) => n.key === 'goods')?.children?.map((n) => n.key)).toEqual([
      'goods.list',
    ])
  })

  it('disabledKeys 命中 DIR 时整棵子树移除', () => {
    const nodes = pruneMenus(MENUS, ctx({ disabledKeys: new Set(['goods']) }))
    expect(nodes.map((n) => n.key)).toEqual(['order'])
  })

  it('side=ADMIN 时不下发 PLATFORM 菜单', () => {
    expect(flattenMenuKeys(pruneMenus(MENUS, ctx({ side: 'ADMIN' })))).not.toContain(
      'platform.tenant',
    )
  })

  it('side=PLATFORM 时只下发平台菜单', () => {
    const nodes = pruneMenus(MENUS, ctx({ side: 'PLATFORM' }))
    expect(nodes.map((n) => n.key)).toEqual(['platform.tenant'])
  })
})

describe('pruneMenus - 排序与输出形状', () => {
  it('同级按 sort 升序', () => {
    expect(pruneMenus(MENUS, ctx()).map((n) => n.key)).toEqual(['order', 'goods'])
  })

  it('sort 相同时保持注册顺序（稳定排序）', () => {
    const defs: MenuDef[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(
      (key) => ({
        key,
        title: key,
        type: 'MENU' as const,
        side: 'ADMIN' as const,
        path: `/${key}`,
        componentKey: key,
        sort: 5,
      }),
    )
    expect(pruneMenus(defs, ctx()).map((n) => n.key)).toEqual(defs.map((d) => d.key))
  })

  it('缺省 sort 视为 0 排在前面', () => {
    const defs: MenuDef[] = [
      { key: 'x', title: 'X', type: 'MENU', side: 'ADMIN', path: '/x', componentKey: 'X', sort: 1 },
      { key: 'y', title: 'Y', type: 'MENU', side: 'ADMIN', path: '/y', componentKey: 'Y' },
    ]
    const nodes = pruneMenus(defs, ctx())
    expect(nodes.map((n) => n.key)).toEqual(['y', 'x'])
    expect(nodes[0]?.sort).toBe(0)
  })

  it('输出只含蓝图 §4.4 的字段加 permission，不泄露 featureKey / side', () => {
    const node = pruneMenus(MENUS, ctx()).find((n) => n.key === 'goods')?.children?.[0]
    expect(Object.keys(node ?? {}).sort()).toEqual(
      ['componentKey', 'key', 'path', 'permission', 'sort', 'title', 'type'].sort(),
    )
    expect(node).not.toHaveProperty('featureKey')
    expect(node).not.toHaveProperty('side')
  })

  it('保留 permission 供前端做 BUTTON 级判断', () => {
    const button = pruneMenus(MENUS, ctx())
      .find((n) => n.key === 'goods')
      ?.children?.find((n) => n.key === 'goods.export')
    expect(button?.type).toBe('BUTTON')
    expect(button?.permission).toBe('goods:export')
  })

  it('不修改传入的注册表（纯函数）', () => {
    const snapshot = JSON.stringify(MENUS)
    pruneMenus(MENUS, ctx({ granted: new Set(['order:list']) }))
    expect(JSON.stringify(MENUS)).toBe(snapshot)
  })
})

describe('buildRoutes / flattenMenuKeys', () => {
  it('抽出 { key, path, componentKey } 扁平列表', () => {
    expect(buildRoutes(pruneMenus(MENUS, ctx()))).toEqual([
      { key: 'order.list', path: '/orders', componentKey: 'OrderList' },
      { key: 'goods.list', path: '/goods', componentKey: 'GoodsList' },
    ])
  })

  it('DIR 不进路由', () => {
    expect(buildRoutes(pruneMenus(MENUS, ctx())).map((r) => r.key)).not.toContain('goods')
  })

  it('BUTTON 不进路由但仍在菜单树里', () => {
    const nodes = pruneMenus(MENUS, ctx())
    expect(buildRoutes(nodes).map((r) => r.key)).not.toContain('goods.export')
    expect(flattenMenuKeys(nodes)).toContain('goods.export')
  })

  it('即便 DIR 上误配了 path 也不进路由', () => {
    const routes = buildRoutes([
      { key: 'd', title: 'D', type: 'DIR', sort: 0, path: '/d', componentKey: 'D' },
    ])
    expect(routes).toEqual([])
  })

  it('MENU 缺 componentKey 时跳过（渲染不出来的路由不下发）', () => {
    expect(buildRoutes([{ key: 'm', title: 'M', type: 'MENU', sort: 0, path: '/m' }])).toEqual([])
  })

  it('flattenMenuKeys 先序遍历全部 key', () => {
    expect(flattenMenuKeys(pruneMenus(MENUS, ctx()))).toEqual([
      'order',
      'order.list',
      'goods',
      'goods.list',
      'goods.export',
    ])
  })

  it('空树的路由与 key 列表都是空数组', () => {
    expect(buildRoutes([])).toEqual([])
    expect(flattenMenuKeys([])).toEqual([])
  })
})
