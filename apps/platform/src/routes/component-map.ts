import { lazy } from 'react'
import { defineComponentMap } from '@taizan/admin-ui'

/**
 * `componentKey → 页面组件` 的映射表（蓝图 §4.4，与
 * `apps/api/src/registry/menus.ts` 汇总的 `PLATFORM_MENUS` 一一对应——死信队列那一条
 * 现在直接登记在 `registry/menus.ts` 里，见那个文件「T3-4：队列死信查看/重放」一节）。
 *
 * 新增一个「有菜单入口」的页面时前端要做两件事：① 这里加一行，② 写页面本身；
 * 两边对不上的表现是「菜单点进去白屏」——`buildRoutes()`/`renderMenus()` 会在控制台
 * warn 并跳过，测试期由 `component-map.spec.ts` 的 `verifyComponentMap()`（本地哨兵）
 * 与 `apps/api/test/arch/menu-route-map.spec.ts`（spec 7，跨包对账）双向兜底。
 *
 * `PlatformTenantDetail`（租户详情，从列表页行内跳转）**刻意不进这份映射表**：
 * 它是列表页的下钻，不是一级菜单，服务端也没有也不该有对应的菜单节点——塞进来会让
 * `verifyComponentMap` 的 `unused` 检查永远非空。它的路由在 `App.tsx` 里手工加在
 * `buildRoutes()` 的结果之外，入口是「租户列表行内『详情』按钮」。
 */
export const componentMap = defineComponentMap({
  PlatformDashboard: lazy(() => import('../pages/PlatformDashboard')),
  PlatformAdminList: lazy(() => import('../pages/PlatformAdminList')),
  PlatformTenantList: lazy(() => import('../pages/PlatformTenantList')),
  PlatformPlanList: lazy(() => import('../pages/PlatformPlanList')),
  PlatformOrderList: lazy(() => import('../pages/PlatformOrderList')),
  PlatformRolePresetList: lazy(() => import('../pages/PlatformRolePresetList')),
  PlatformAnnouncementList: lazy(() => import('../pages/PlatformAnnouncementList')),
  PlatformAuditLogList: lazy(() => import('../pages/PlatformAuditList')),
  PlatformJobDeadLetter: lazy(() => import('../pages/PlatformJobDeadLetter')),
})
