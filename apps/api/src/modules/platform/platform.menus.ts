/**
 * `/api/platform` 侧（`side: 'PLATFORM'`）的菜单树（T1-7）。
 *
 * 形状照抄 `example-goods/goods.menus.ts`：每个 `MENU` 节点带 `componentKey`（前端
 * `component-map.ts` 按它映射到组件，服务端不知道也不该知道文件路径），`componentKey`
 * 统一 `Platform*` 前缀以便和商家后台（`Admin*`/无前缀）的组件一眼区分。
 *
 * **本文件本身不接线**——蓝图 §7 扩展点④要求汇总在 `src/registry/menus.ts`，
 * 但那份文件由另一个正在并行改 `apps/api` 其它部分的 agent 维护（见任务边界），
 * 这里只是把 T1-7 这批菜单定义出来，等汇总方 `import { PLATFORM_MENUS } from
 * '../modules/platform/platform.menus'` 接进去。
 *
 * `permission` 字段引用的 code 已经在同目录 `platform.permissions.ts`（`PLATFORM_PERMISSIONS`）
 * 里注册好——`RbacModule.forRoot()` 的 `MenuRegistry` 会拒绝引用未注册权限点的菜单，
 * 汇总方需要把 `PLATFORM_PERMISSIONS` 一并并入 `src/registry/permissions.ts` 的 `PERMISSIONS`，
 * 这两份汇总必须同时做，先接菜单不接权限点会在启动期直接炸。
 *
 * @packageDocumentation
 */

import { defineMenus, type MenuDef } from '@taizan/contracts'

/** T1-7 平台管理面的菜单树。 */
export const PLATFORM_MENUS: readonly MenuDef[] = defineMenus([
  {
    key: 'platform-admin',
    title: '管理员',
    icon: 'TeamOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/admins',
    componentKey: 'PlatformAdminList',
    permission: 'platform-admin:list',
    sort: 10,
  },
  {
    key: 'platform-tenant',
    title: '租户管理',
    icon: 'ShopOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/tenants',
    componentKey: 'PlatformTenantList',
    permission: 'platform-tenant:list',
    sort: 20,
  },
  {
    key: 'platform-plan',
    title: '套餐',
    icon: 'GiftOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/plans',
    componentKey: 'PlatformPlanList',
    permission: 'platform-plan:list',
    sort: 30,
  },
  {
    key: 'platform-order',
    title: '订单',
    icon: 'FileTextOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/orders',
    componentKey: 'PlatformOrderList',
    permission: 'platform-order:list',
    sort: 40,
  },
  {
    key: 'platform-role-preset',
    title: '角色预设',
    icon: 'SafetyCertificateOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/role-presets',
    componentKey: 'PlatformRolePresetList',
    permission: 'platform-role-preset:list',
    sort: 50,
  },
  {
    key: 'platform-announcement',
    title: '公告',
    icon: 'NotificationOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/announcements',
    componentKey: 'PlatformAnnouncementList',
    permission: 'platform-announcement:list',
    sort: 60,
  },
  {
    key: 'platform-audit',
    title: '审计日志',
    icon: 'AuditOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/audit-logs',
    componentKey: 'PlatformAuditLogList',
    permission: 'platform-audit:list',
    sort: 70,
  },
  {
    key: 'platform-dashboard',
    title: '数据看板',
    icon: 'DashboardOutlined',
    type: 'MENU',
    side: 'PLATFORM',
    path: '/dashboard',
    componentKey: 'PlatformDashboard',
    permission: 'platform-dashboard:view',
    sort: 5,
  },
])
