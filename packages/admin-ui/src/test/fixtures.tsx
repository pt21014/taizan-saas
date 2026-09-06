import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { create } from 'zustand'
import { MemoryRouter } from 'react-router-dom'
import { SessionProvider, type SessionState } from '../session'
import type { RoutableMenuNode } from '../menu'

/** 造一份可控的会话 store：只填测试关心的字段，其余给安全默认值。 */
export function makeSessionStore(patch: Partial<SessionState> = {}) {
  return create<SessionState>(() => ({
    identity: null,
    tenant: {
      id: 't1',
      slug: 'shop-1',
      name: '一号店',
      status: 'ACTIVE',
      planExpireAt: null,
      readonly: false,
      features: null,
    },
    shops: [],
    permissions: [],
    menus: [],
    quotas: {},
    token: 'tok',
    status: 'ready',
    request: {} as SessionState['request'],
    bootstrap: vi.fn(),
    login: vi.fn(),
    switchTenant: vi.fn(),
    logout: vi.fn(),
    ...patch,
  }))
}

/** 把被测组件包进 `<MemoryRouter>` + `<SessionProvider>`。 */
export function withSession(
  children: ReactNode,
  patch: Partial<SessionState> = {},
  initialEntries: string[] = ['/'],
) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <SessionProvider store={makeSessionStore(patch)}>{children}</SessionProvider>
    </MemoryRouter>
  )
}

/** 一棵覆盖 DIR / MENU / BUTTON 三种类型的菜单树。 */
export const MENU_FIXTURE: RoutableMenuNode[] = [
  {
    key: 'dashboard',
    title: '工作台',
    path: '/',
    componentKey: 'Dashboard',
    type: 'MENU',
    sort: 0,
  },
  {
    key: 'goods',
    title: '商品',
    type: 'DIR',
    sort: 10,
    children: [
      {
        key: 'goods.list',
        title: '商品列表',
        path: '/goods',
        componentKey: 'GoodsList',
        permission: 'goods:list',
        type: 'MENU',
        sort: 10,
      },
      {
        key: 'goods.export',
        title: '导出商品',
        path: '/goods/export',
        componentKey: 'GoodsExport',
        permission: 'goods:export',
        type: 'MENU',
        sort: 20,
      },
      // BUTTON 只是按钮级权限点的载体，既不进路由也不进侧边栏。
      { key: 'goods.write.btn', title: '新增商品', type: 'BUTTON', sort: 30 },
    ],
  },
  {
    key: 'legacy',
    title: '老页面',
    path: '/legacy',
    componentKey: 'NotRegistered',
    type: 'MENU',
    sort: 20,
  },
]

/**
 * antd 会在两个汉字的按钮文案中间插一个空格（「保存」渲染成 `保 存`），
 * 所以 `getByRole('button', { name: '保存' })` 永远找不到。用这个匹配器忽略空白。
 */
export function btnName(name: string) {
  return (accessibleName: string): boolean => accessibleName.replace(/\s+/g, '') === name
}
