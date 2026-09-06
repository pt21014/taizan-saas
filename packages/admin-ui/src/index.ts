/**
 * `@taizan/admin-ui`：`apps/admin` 与 `apps/platform` 共用的后台基座层（蓝图 §5.2）。
 *
 * - `request`：基于 `@taizan/contracts` 的信封客户端 + 错误码分流（401 清态、`1440301` 去续费）
 * - `session`：zustand store，唯一真源来自 `GET /api/admin/auth/bootstrap`
 * - `layout` / `auth` / `theme`：`<AppShell>`、登录与选店、antd 主题
 * - `gate`：只读闸门（`useWritable`/`useWritableHere`/`<ReadonlyBanner>`）
 * - `menu`：服务端菜单 → 路由与侧边栏（`buildRoutes`/`renderMenus`/`defineComponentMap`/`verifyComponentMap`）
 * - `perm`：权限路由与按钮权限（`usePerm`/`<Perm>`/`withPerm`/`<RequirePermission>`/`<RequireAuth>`）
 * - `crud`：`useCrudTable`/`useCrudForm`/`<CrudTable>`/`<CrudDrawerForm>` 与常用列工厂
 * - `upload`：`<ImageUpload>`/`<MaterialPicker>`（`@taizan/storage` 预签名直传契约）
 */
export * from './request'
export * from './session'
export * from './layout'
export * from './auth'
export * from './gate'
export * from './theme'
export * from './menu'
export * from './perm'
export * from './crud'
export * from './upload'
