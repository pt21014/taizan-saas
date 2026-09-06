import { useEffect, useMemo } from 'react'
import { Outlet, useLocation, useRoutes } from 'react-router-dom'
import { AppShell, LoginPage, RequireAuth, buildRoutes, readReturnTo } from '@taizan/admin-ui'
import NotFoundPage from './pages/NotFoundPage'
import { componentMap } from './routes/component-map'
import { useSession } from './session'

export default function App() {
  const token = useSession((s) => s.token)
  const status = useSession((s) => s.status)
  const menus = useSession((s) => s.menus)
  const bootstrap = useSession((s) => s.bootstrap)
  const location = useLocation()

  // 刷新页面后 token 还在（store 的初值就是从 localStorage 读的），但其余字段是空的：补一次 bootstrap
  useEffect(() => {
    if (token && status === 'idle') void bootstrap()
  }, [token, status, bootstrap])

  // 路由表由服务端下发的菜单生成——不再手写一长串静态 import（蓝图 §5.2）。
  const routes = useMemo(
    () => buildRoutes(menus, componentMap, { notFound: NotFoundPage }),
    [menus],
  )

  return useRoutes([
    {
      path: '/login',
      // 登录成功后跳回 <RequireAuth> 记下的原地址（?returnTo=），没有就落工作台
      element: (
        <LoginPage
          config={{
            title: '@taizan/admin-ui demo',
            homePath: readReturnTo(location.search) ?? '/',
          }}
        />
      ),
    },
    {
      element: (
        <RequireAuth>
          <AppShell>
            <Outlet />
          </AppShell>
        </RequireAuth>
      ),
      children: routes,
    },
  ])
}
