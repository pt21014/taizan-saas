import { Suspense, type ComponentType, type ReactElement } from 'react'
import { Spin } from 'antd'
import type { RouteObject } from 'react-router-dom'
import type { PermissionExpr } from '@taizan/rbac-core'
import { RequirePermission } from '../perm/RequirePermission'
import type { ComponentMap } from './componentMap'
import type { RoutableMenuNode } from './types'
import { warnMissingComponentKey, warnUnknownComponentKey } from './warn'

/** {@link buildRoutes} 的可选项。 */
export interface BuildRoutesOptions {
  /** `React.lazy` 加载中的占位，缺省是一个居中的 antd `<Spin>` */
  fallback?: ComponentType
  /** 兜底路由（`path: '*'`）的组件；不传就不生成兜底路由 */
  notFound?: ComponentType
  /** 覆盖默认 403 页（透传给 `<RequirePermission>`） */
  forbidden?: ComponentType<{ code?: string }>
  /**
   * 从菜单节点取权限表达式。缺省读 `node.permission`。
   *
   * 留这个钩子是给「服务端不透传 permission」的部署用的：前端应用可以拿自己那份
   * `menuKey → permission` 的静态表来补，而不必改协议。
   */
  permissionOf?: (node: RoutableMenuNode) => PermissionExpr | undefined
}

function DefaultFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
      <Spin />
    </div>
  )
}

function collect(
  nodes: readonly RoutableMenuNode[],
  componentMap: ComponentMap,
  opts: Required<Pick<BuildRoutesOptions, 'permissionOf'>> & BuildRoutesOptions,
  out: RouteObject[],
): void {
  const Fallback = opts.fallback ?? DefaultFallback

  for (const node of nodes) {
    const hasPath = node.path !== undefined && node.path.length > 0

    // DIR 是纯分组，没有自己的页面——它只出现在侧边栏里，不进路由。
    // BUTTON 只用于按钮级权限点（usePerm()），更不进路由。
    if (node.type === 'MENU' && hasPath) {
      const componentKey = node.componentKey
      if (componentKey === undefined || componentKey.length === 0) {
        warnMissingComponentKey(node.key, 'buildRoutes()')
      } else {
        const Component = componentMap[componentKey]
        if (Component === undefined) {
          // 跳过而不是渲染一个空组件：白屏是最难排查的失败形态，
          // 少一条路由至少会落到兜底的 404，控制台里还有这条 warn 指名道姓。
          warnUnknownComponentKey(componentKey, 'buildRoutes()')
        } else {
          const element: ReactElement = (
            <RequirePermission code={opts.permissionOf(node)} forbidden={opts.forbidden}>
              <Suspense fallback={<Fallback />}>
                <Component />
              </Suspense>
            </RequirePermission>
          )
          out.push({ path: node.path, element })
        }
      }
    }

    if (node.children !== undefined && node.children.length > 0) {
      collect(node.children, componentMap, opts, out)
    }
  }
}

/**
 * 服务端下发的菜单树 → `react-router` 的 `RouteObject[]`（蓝图 §5.2）。
 *
 * ## 规则
 *
 * - 只有 `type: 'MENU'` 且有 `path` 的节点建路由；`DIR`（纯分组）与 `BUTTON`（按钮权限点）不建；
 * - `componentKey` 缺失或不在 `componentMap` 里 → `console.warn` **并跳过**，不渲染空白页；
 * - **每一条**路由都包一层 `<RequirePermission code={node.permission}>`：菜单被裁掉时
 *   路由压根不存在（落 404），但服务端透传了 `permission` 时，直达 URL 会得到一张明确的 403；
 * - 路由是**扁平**的（子菜单的 path 是完整路径，不是相对父节点的片段）——服务端菜单里
 *   `path` 就是绝对路径，做成嵌套反而要求菜单树结构和 URL 结构一一对应，那是两回事。
 *
 * 通常把结果塞进 `<AppShell>` 的 `children: <Outlet />` 下：
 *
 * ```tsx
 * const routes = useMemo(() => buildRoutes(menus, componentMap, { notFound: NotFoundPage }), [menus])
 * const element = useRoutes([
 *   { path: '/login', element: <LoginPage /> },
 *   { element: <RequireAuth><AppShell><Outlet /></AppShell></RequireAuth>, children: routes },
 * ])
 * ```
 *
 * 注意与 `@taizan/rbac-core` 的同名函数区分：那个是**服务端**用的纯函数，
 * 返回扁平的 `{key, path, componentKey}` 列表，不认识 React。
 */
export function buildRoutes(
  menus: readonly RoutableMenuNode[],
  componentMap: ComponentMap,
  opts: BuildRoutesOptions = {},
): RouteObject[] {
  const routes: RouteObject[] = []
  collect(
    menus,
    componentMap,
    { ...opts, permissionOf: opts.permissionOf ?? ((node) => node.permission) },
    routes,
  )

  if (opts.notFound !== undefined) {
    const NotFound = opts.notFound
    routes.push({ path: '*', element: <NotFound /> })
  }
  return routes
}
