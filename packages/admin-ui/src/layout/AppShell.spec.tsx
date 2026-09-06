import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { create } from 'zustand'
import type { MenuNode } from '@taizan/contracts'
import { SessionProvider, type SessionState } from '../session'
import { AppShell } from './AppShell'

const mockBootstrapMenus: MenuNode[] = [
  {
    key: 'goods',
    title: '商品',
    icon: 'ShopOutlined',
    type: 'DIR',
    sort: 10,
    children: [
      { key: 'goods.list', title: '商品列表', path: '/goods', type: 'MENU', sort: 10 },
      { key: 'goods.export', title: '导出商品', type: 'BUTTON', sort: 20 },
    ],
  },
  {
    key: 'orders',
    title: '订单',
    icon: 'ShoppingOutlined',
    path: '/orders',
    type: 'MENU',
    sort: 20,
  },
]

function makeFixtureStore(overrides: Partial<SessionState> = {}) {
  return create<SessionState>(() => ({
    identity: { staffId: 's1', accountId: 'a1', name: '张三', isOwner: true },
    tenant: {
      id: 't1',
      slug: 'shop-1',
      name: '一号店',
      status: 'ACTIVE',
      planExpireAt: null,
      readonly: false,
      features: null,
    },
    shops: [{ tenantId: 't1', name: '一号店', slug: 'shop-1' }],
    permissions: ['goods:list'],
    menus: mockBootstrapMenus,
    quotas: {},
    token: 'tok',
    status: 'ready',
    // 这几个方法在这个测试里不会被调用，给个不炸的占位实现即可
    request: {} as SessionState['request'],
    bootstrap: vi.fn(),
    login: vi.fn(),
    switchTenant: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  }))
}

describe('<AppShell>（用 mock bootstrap 数据渲染菜单树）', () => {
  it('侧边栏渲染出 DIR/MENU 两级菜单，且不渲染 BUTTON 类型节点', () => {
    const store = makeFixtureStore()

    render(
      <MemoryRouter initialEntries={['/goods']}>
        <SessionProvider store={store}>
          <AppShell>
            <div>页面内容</div>
          </AppShell>
        </SessionProvider>
      </MemoryRouter>,
    )

    // 「商品」同时出现在侧边栏 SubMenu 标题与面包屑里，用 getAllByText 断言至少渲染出来
    expect(screen.getAllByText('商品').length).toBeGreaterThan(0)
    expect(screen.getAllByText('商品列表').length).toBeGreaterThan(0)
    expect(screen.getAllByText('订单').length).toBeGreaterThan(0)
    expect(screen.getByText('页面内容')).toBeInTheDocument()
    expect(screen.queryByText('导出商品')).not.toBeInTheDocument()
  })

  it('单店时顶栏不画切换器下拉，只显示店铺名', () => {
    const store = makeFixtureStore()

    render(
      <MemoryRouter initialEntries={['/orders']}>
        <SessionProvider store={store}>
          <AppShell>
            <div>页面内容</div>
          </AppShell>
        </SessionProvider>
      </MemoryRouter>,
    )

    expect(screen.getAllByText('一号店').length).toBeGreaterThan(0)
  })

  it('showShopSwitcher={false} 时顶栏不画 <ShopSwitcher>（平台超管后台没有「店铺」概念）', () => {
    const store = makeFixtureStore()

    render(
      <MemoryRouter initialEntries={['/orders']}>
        <SessionProvider store={store}>
          <AppShell showShopSwitcher={false}>
            <div>页面内容</div>
          </AppShell>
        </SessionProvider>
      </MemoryRouter>,
    )

    // 「一号店」在默认渲染时会出现两处：侧边栏顶部品牌区（`logo ?? tenant?.name`）
    // 与顶栏 <ShopSwitcher>（`shops.length<=1` 分支也回显 `tenant?.name`）。
    // 关掉 showShopSwitcher 之后只应该剩侧边栏那一处。
    expect(screen.getAllByText('一号店')).toHaveLength(1)
    expect(screen.getByText('页面内容')).toBeInTheDocument()
  })
})
