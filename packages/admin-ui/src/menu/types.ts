import type { MenuNode } from '@taizan/contracts'
import type { PermissionExpr } from '@taizan/rbac-core'

/**
 * 前端侧用的菜单节点。
 *
 * 契约里的 `MenuNode`（`@taizan/contracts`）**不含** `permission`——服务端下发前已经按
 * 权限 ∩ 套餐 features ∩ 显式禁用 裁剪过一轮，前端理论上拿不到自己无权看的菜单。
 *
 * 但路由不能只靠「菜单里没有」来防：用户可以直接敲 URL，而这条路由是否存在取决于
 * 菜单树——菜单被裁掉时那条路由压根不会被建出来，用户看到的是「404」而不是「403」，
 * 分不清「没这个页面」和「没这个权限」。所以这里允许服务端**额外**透传一个
 * `permission` 字段（JSON 多带一个字段不违反契约），`buildRoutes` 会用它包
 * `<RequirePermission>`，直达 URL 得到的就是一张明确的 403。
 *
 * 服务端没透传时也不影响：`buildRoutes` 照样包一层 `<RequirePermission>`（`code` 为
 * `undefined` 时直接放行），行为与不包一致，但结构统一、可断言。
 */
export interface RoutableMenuNode extends MenuNode {
  /** 该页面要求的权限点表达式（`'a|b'` 或 / `['a','b']` 与），缺省表示不受权限约束 */
  permission?: PermissionExpr
  children?: RoutableMenuNode[]
}
