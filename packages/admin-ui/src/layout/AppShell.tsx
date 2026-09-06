import type { ReactNode } from 'react'
import { Layout, Menu } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSession } from '../session'
import { ReadonlyBanner } from '../gate/ReadonlyBanner'
import { BreadcrumbBar } from './BreadcrumbBar'
import { ShopSwitcher } from './ShopSwitcher'
import { UserMenu } from './UserMenu'
import { buildAntdMenuItems, findMenuTrail } from './menu-tree'

const { Header, Sider, Content } = Layout

export interface AppShellProps {
  /** 页面主体内容；T3-2 接完权限路由后通常是 `<Outlet />` */
  children: ReactNode
  /** 侧栏顶部的品牌区域，缺省显示租户名 */
  logo?: ReactNode
  /** 登录页路径，透传给 `<UserMenu>` */
  loginPath?: string
  /** 账单页路径，透传给 `<ReadonlyBanner>` */
  billingPath?: string
  /**
   * 顶栏是否画 `<ShopSwitcher>`。默认 `true`（商家后台）。
   *
   * 平台超管后台没有「店铺」这个概念——`session.shops` 恒为空数组，`<ShopSwitcher>`
   * 会退化显示一句「当前店铺」文案，跟平台超管的语境完全不符（见
   * `apps/platform/README.md`「admin-ui 需要扩展的点」③）。平台侧传 `false`。
   */
  showShopSwitcher?: boolean
}

/**
 * 商家/平台后台的混合布局（蓝图 §5.2）：侧栏菜单来自 `session.menus`（服务端已裁剪），
 * 顶栏 `<ShopSwitcher>` + `<UserMenu>` + `<BreadcrumbBar>`，只读态下顶部再叠一条
 * `<ReadonlyBanner>`。菜单渲染只认 `MenuNode`（key/title/icon/path/children），
 * 点击按 `path` 走 `react-router-dom` 的 `navigate()`——真正的路由表/权限过滤是 T3-2
 * 的 `buildRoutes()`，这里只负责「点了之后跳到哪」。
 */
export function AppShell({
  children,
  logo,
  loginPath,
  billingPath,
  showShopSwitcher = true,
}: AppShellProps) {
  const menus = useSession((s) => s.menus)
  const tenant = useSession((s) => s.tenant)
  const navigate = useNavigate()
  const location = useLocation()

  const items = buildAntdMenuItems(menus)
  const trail = findMenuTrail(menus, location.pathname)

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" breakpoint="lg">
        <div
          style={{
            color: '#fff',
            padding: 16,
            fontSize: 16,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {logo ?? tenant?.name ?? 'Taizan'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={trail.keys.length > 0 ? [trail.keys[trail.keys.length - 1] as string] : []}
          defaultOpenKeys={trail.keys.slice(0, -1)}
          items={items}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 24,
            paddingInline: 24,
          }}
        >
          {showShopSwitcher && <ShopSwitcher />}
          <UserMenu loginPath={loginPath} />
        </Header>
        <ReadonlyBanner billingPath={billingPath} />
        <Content style={{ padding: '0 16px' }}>
          <BreadcrumbBar />
          {children}
        </Content>
      </Layout>
    </Layout>
  )
}
