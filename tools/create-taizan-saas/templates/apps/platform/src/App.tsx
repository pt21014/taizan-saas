import { useEffect, useMemo } from 'react'
import { Navigate, Outlet, useRoutes } from 'react-router-dom'
import { AppShell, RequireAuth, buildRoutes } from '@taizan/admin-ui'
import { componentMap } from './routes/component-map'
import { useSession } from './session'
import PlatformLoginPage from './pages/PlatformLoginPage'
import PlatformTenantDetail from './pages/PlatformTenantDetail'
import NotFoundPage from './pages/NotFoundPage'

export default function App() {
  const token = useSession((s) => s.token)
  const status = useSession((s) => s.status)
  const menus = useSession((s) => s.menus)
  const bootstrap = useSession((s) => s.bootstrap)

  // 刷新页面后 token 还在（store 的初值就是从 localStorage 读的），但菜单/权限是空的：
  // 补一次真正的 `GET /api/platform/auth/bootstrap`（见 src/session.ts，T3-4 之前这里
  // 是「/auth/me 验活 + 前端静态菜单」的退化实现）。
  useEffect(() => {
    if (token && status === 'idle') void bootstrap()
  }, [token, status, bootstrap])

  // 服务端下发的菜单生成的路由——新增一级菜单页面只需要 apps/api 侧改
  // `registry/menus.ts`/`modules/platform/platform.menus.ts` + 这里的 component-map.ts
  // 加一行，App.tsx 本身不用动。
  //
  // `permissionOf: () => undefined`：关掉 `buildRoutes()` 默认给每条路由包一层
  // `<RequirePermission code={node.permission}>` 的行为。原因见
  // `session.ts`/`platform-auth.service.ts` 的注释——`bootstrap` 下发的 `permissions`
  // 本阶段是字面量 `['*']`（平台侧全权，真实按角色展开是 TODO），`usePerm().has(code)`
  // 做精确匹配、不认通配符，会让**每一个**挂了 `permission` 的菜单都直达 403。
  // 菜单本身已经在服务端按（此刻恒为全量的）权限集合裁剪过，这里再拿一份对不上的
  // `'*'` 去重复校验一遍只会产生假阳性；等平台侧真的按角色收窄，这个覆盖要删掉。
  const menuRoutes = useMemo(
    () =>
      buildRoutes(menus, componentMap, { notFound: NotFoundPage, permissionOf: () => undefined }),
    [menus],
  )

  return useRoutes([
    { path: '/login', element: <PlatformLoginPage /> },
    {
      element: (
        <RequireAuth>
          <AppShell logo="太阶 · 平台后台" showShopSwitcher={false}>
            <Outlet />
          </AppShell>
        </RequireAuth>
      ),
      children: [
        { path: '/', element: <Navigate to="/dashboard" replace /> },
        ...menuRoutes,
        // 唯一一条不进侧边栏的路由，手工加在 buildRoutes() 的结果之外——它是列表页的
        // 下钻（`:tenantId` 参数化），不是一级菜单，见 routes/component-map.ts 头部注释。
        // 死信队列那条（原来也在这里手工加）现在已经有服务端菜单节点，走 menuRoutes 即可。
        { path: '/tenants/:tenantId', element: <PlatformTenantDetail /> },
      ],
    },
  ])
}
