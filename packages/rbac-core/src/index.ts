/**
 * `@taizan/rbac-core`：RBAC 的纯函数内核（蓝图 §4.4）。
 *
 * 零框架依赖，只依赖 `@taizan/contracts` 的协议类型（`PermissionDef`/`MenuDef`/`MenuNode`/
 * `MenuSide`），可以在裸 node 环境跑单测。三块职责：
 *
 * - `permission`：权限表达式（`'a|b'` 或 / `['a','b']` 与）求值、角色展开、通配处理；
 * - `menu-tree`：菜单树按 权限 ∩ 套餐 features ∩ 显式禁用 ∩ 所属侧 裁剪、路由抽取；
 * - `data-scope`：`ALL/SUB_TREE/SELF/CUSTOM` 到 Prisma `where` 片段的翻译；
 * - `define`：角色预设定义与店主角色授予规则。
 *
 * 执行层（`@RequirePermission` 装饰器、`PermissionsGuard`、`@DataScope()` 拦截器、
 * 注册表与 DB 的同步命令）在 `@taizan/nest-rbac`，这里不碰 Nest。
 */
export * from './permission'
export * from './menu-tree'
export * from './data-scope'
export * from './define'
