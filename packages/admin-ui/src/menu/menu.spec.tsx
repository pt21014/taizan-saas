import { lazy, type ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { SessionProvider } from '../session'
import { RequirePermission } from '../perm'
import { MENU_FIXTURE, makeSessionStore } from '../test/fixtures'
import { buildRoutes } from './buildRoutes'
import { defineComponentMap, isValidComponentKey, type ComponentMap } from './componentMap'
import { filterRenderableMenus, renderMenus } from './renderMenus'
import { describeComponentMapReport, verifyComponentMap } from './verifyComponentMap'
import { resetComponentKeyWarnings } from './warn'

function page(text: string) {
  return lazy(() => Promise.resolve({ default: () => <div>{text}</div> }))
}

const componentMap: ComponentMap = defineComponentMap({
  Dashboard: page('工作台页'),
  GoodsList: page('商品列表页'),
  GoodsExport: page('导出页'),
})

describe('defineComponentMap()', () => {
  it('接受 PascalCase 的 key 并冻结映射表', () => {
    const map = defineComponentMap({ GoodsList: page('x') })
    expect(Object.isFrozen(map)).toBe(true)
    expect(() => {
      ;(map as Record<string, unknown>).Injected = page('y')
    }).toThrow()
  })

  it('key 不是 PascalCase 时直接抛错（后端菜单里写的就是这个 key，两边不能各写各的）', () => {
    expect(() => defineComponentMap({ 'goods-list': page('x') })).toThrow('PascalCase')
    expect(() => defineComponentMap({ 'goods.list': page('x') })).toThrow('PascalCase')
    expect(() => defineComponentMap({ goodsList: page('x') })).toThrow('PascalCase')
  })

  it('isValidComponentKey 与校验规则一致', () => {
    expect(isValidComponentKey('PlatformTenantList')).toBe(true)
    expect(isValidComponentKey('Goods2List')).toBe(true)
    expect(isValidComponentKey('goodsList')).toBe(false)
    expect(isValidComponentKey('')).toBe(false)
  })
})

describe('buildRoutes()', () => {
  beforeEach(() => resetComponentKeyWarnings())

  it('只给 type=MENU 且有 path 的节点建路由，DIR 不进路由', () => {
    const routes = buildRoutes(MENU_FIXTURE, componentMap)
    expect(routes.map((r) => r.path)).toEqual(['/', '/goods', '/goods/export'])
    expect(routes.map((r) => r.path)).not.toContain(undefined)
  })

  it('BUTTON 节点不进路由（它只是按钮级权限点的载体）', () => {
    const routes = buildRoutes(
      [{ key: 'b', title: '按钮', type: 'BUTTON', sort: 1, componentKey: 'GoodsList', path: '/b' }],
      componentMap,
    )
    expect(routes).toHaveLength(0)
  })

  it('componentKey 不在映射表里时打 warn 并跳过，不渲染空白页', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const routes = buildRoutes(MENU_FIXTURE, componentMap)
    expect(routes.some((r) => r.path === '/legacy')).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('NotRegistered')
    warn.mockRestore()
  })

  it('同一个未注册 key 只 warn 一次，不刷屏', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    buildRoutes(MENU_FIXTURE, componentMap)
    buildRoutes(MENU_FIXTURE, componentMap)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('MENU 有 path 却没有 componentKey 时也 warn 并跳过', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const routes = buildRoutes(
      [{ key: 'x', title: '缺组件', path: '/x', type: 'MENU', sort: 1 }],
      componentMap,
    )
    expect(routes).toHaveLength(0)
    expect(warn.mock.calls[0]?.[0]).toContain('没有 componentKey')
    warn.mockRestore()
  })

  it('每条路由都被 <RequirePermission> 包裹（带 code 的透传菜单 permission）', () => {
    const routes = buildRoutes(MENU_FIXTURE, componentMap)
    for (const route of routes) {
      const element = route.element as ReactElement<{ code?: string }>
      expect(element.type).toBe(RequirePermission)
    }
    const goods = routes.find((r) => r.path === '/goods')
    expect((goods?.element as ReactElement<{ code?: string }>).props.code).toBe('goods:list')
  })

  it('permissionOf 钩子可以覆盖菜单自带的 permission', () => {
    const routes = buildRoutes(MENU_FIXTURE, componentMap, {
      permissionOf: (node) => (node.key === 'dashboard' ? 'home:view' : undefined),
    })
    const home = routes.find((r) => r.path === '/')
    expect((home?.element as ReactElement<{ code?: string }>).props.code).toBe('home:view')
  })

  it('传了 notFound 才追加兜底路由', () => {
    const withNotFound = buildRoutes(MENU_FIXTURE, componentMap, {
      notFound: () => <div>404</div>,
    })
    expect(withNotFound.at(-1)?.path).toBe('*')
    expect(buildRoutes(MENU_FIXTURE, componentMap).at(-1)?.path).not.toBe('*')
  })

  it('有权限时真的渲染出页面，直达无权限的 URL 渲染 403 而不是白屏', async () => {
    const routes = buildRoutes(MENU_FIXTURE, componentMap)
    const store = makeSessionStore({ permissions: ['goods:list'] })

    const router = createMemoryRouter(routes, { initialEntries: ['/goods'] })
    render(
      <SessionProvider store={store}>
        <RouterProvider router={router} />
      </SessionProvider>,
    )
    expect(await screen.findByText('商品列表页')).toBeInTheDocument()

    const forbiddenRouter = createMemoryRouter(routes, { initialEntries: ['/goods/export'] })
    render(
      <SessionProvider store={store}>
        <RouterProvider router={forbiddenRouter} />
      </SessionProvider>,
    )
    expect(await screen.findByText('403')).toBeInTheDocument()
    expect(screen.getByText(/goods:export/)).toBeInTheDocument()
  })
})

describe('renderMenus() / filterRenderableMenus()', () => {
  beforeEach(() => resetComponentKeyWarnings())

  it('BUTTON 节点不渲染进侧边栏', () => {
    const items = renderMenus(MENU_FIXTURE, componentMap)
    const goods = items.find((item) => item?.key === 'goods') as { children?: { key: string }[] }
    expect(goods.children?.map((c) => c.key)).toEqual(['/goods', '/goods/export'])
  })

  it('componentKey 未注册的菜单项不给入口（与 buildRoutes 一致，避免点进去白屏）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const items = renderMenus(MENU_FIXTURE, componentMap)
    expect(items.map((i) => i?.key)).not.toContain('/legacy')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('不传 componentMap 时只过滤 BUTTON（<AppShell> 早于路由装配存在）', () => {
    const items = renderMenus(MENU_FIXTURE)
    expect(items.map((i) => i?.key)).toContain('/legacy')
  })

  it('裁完之后空掉的 DIR 整个不渲染（不给一个点进去空空如也的分组）', () => {
    const filtered = filterRenderableMenus(
      [
        {
          key: 'dir',
          title: '空分组',
          type: 'DIR',
          sort: 1,
          children: [{ key: 'btn', title: '按钮', type: 'BUTTON', sort: 1 }],
        },
      ],
      componentMap,
    )
    expect(filtered).toEqual([])
  })

  it('菜单项的 key 用 path，点击后可以直接 navigate(key)', () => {
    const items = renderMenus(MENU_FIXTURE)
    expect(items[0]?.key).toBe('/')
  })
})

describe('verifyComponentMap()（蓝图 §8 spec 7 menu-route-map）', () => {
  it('双向对齐时 ok', () => {
    const report = verifyComponentMap(
      [
        { key: 'a', title: 'A', path: '/a', componentKey: 'GoodsList', type: 'MENU', sort: 1 },
        { key: 'b', title: 'B', path: '/b', componentKey: 'Dashboard', type: 'MENU', sort: 2 },
      ],
      ['GoodsList', 'Dashboard'],
    )
    expect(report).toEqual({ ok: true, missing: [], unused: [], pathWithoutComponentKey: [] })
    expect(describeComponentMapReport(report)).toBe('componentKey 双向对齐')
  })

  it('菜单引用了映射表里没有的 key → missing', () => {
    const report = verifyComponentMap(MENU_FIXTURE, componentMap)
    expect(report.missing).toEqual(['NotRegistered'])
    expect(report.ok).toBe(false)
    expect(describeComponentMapReport(report)).toContain('NotRegistered')
  })

  it('映射表里登记了但没有菜单引用 → unused（只查一个方向的话删页面忘删菜单还是能过）', () => {
    const report = verifyComponentMap(
      [{ key: 'a', title: 'A', path: '/a', componentKey: 'GoodsList', type: 'MENU', sort: 1 }],
      componentMap,
    )
    expect(report.unused).toEqual(['Dashboard', 'GoodsExport'])
  })

  it('MENU 有 path 却没写 componentKey → pathWithoutComponentKey', () => {
    const report = verifyComponentMap(
      [{ key: 'a', title: 'A', path: '/a', type: 'MENU', sort: 1 }],
      [],
    )
    expect(report.pathWithoutComponentKey).toEqual(['a'])
    expect(report.ok).toBe(false)
  })

  it('DIR 没有 path 也没有 componentKey，不算漏', () => {
    const report = verifyComponentMap(
      [
        {
          key: 'dir',
          title: '分组',
          type: 'DIR',
          sort: 1,
          children: [
            { key: 'a', title: 'A', path: '/a', componentKey: 'GoodsList', type: 'MENU', sort: 1 },
          ],
        },
      ],
      ['GoodsList'],
    )
    expect(report.ok).toBe(true)
  })

  it('Set / 数组 / 对象三种 componentMap 形状都能喂进来', () => {
    const menus = [
      {
        key: 'a',
        title: 'A',
        path: '/a',
        componentKey: 'GoodsList',
        type: 'MENU' as const,
        sort: 1,
      },
    ]
    expect(verifyComponentMap(menus, new Set(['GoodsList'])).ok).toBe(true)
    expect(verifyComponentMap(menus, ['GoodsList']).ok).toBe(true)
    expect(verifyComponentMap(menus, { GoodsList: 1 }).ok).toBe(true)
  })

  it('哨兵：往菜单里塞一个必然不存在的 key，对账必须报出来（防止校验逻辑失效后静默通过）', () => {
    // 这条用例守的是 verifyComponentMap 本身：如果哪天遍历写错（比如忘了递归 children），
    // 上面那些「应该 ok」的用例照样绿，只有这条会红。
    const sentinel = '__SentinelNeverRegistered__'
    const report = verifyComponentMap(
      [
        {
          key: 'dir',
          title: '分组',
          type: 'DIR',
          sort: 1,
          children: [
            {
              key: 'deep',
              title: '深层',
              path: '/deep',
              componentKey: sentinel,
              type: 'MENU',
              sort: 1,
            },
          ],
        },
      ],
      ['GoodsList'],
    )
    expect(report.missing).toContain(sentinel)
    expect(report.ok).toBe(false)
  })
})
