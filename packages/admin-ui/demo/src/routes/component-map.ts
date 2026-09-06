import { lazy } from 'react'
import { defineComponentMap } from '@taizan/admin-ui'

/**
 * `componentKey → 页面组件` 的映射表（蓝图 §4.4）。
 *
 * `apps/admin` / `apps/platform` 各有一份**长得一模一样**的文件，只是内容不同——
 * 这是新增一个业务页面时前端要做的两件事之一（另一件是写页面本身）：
 * 后端 `goods.menus.ts` 里写 `componentKey: 'GoodsList'`，这里加一行 `GoodsList: lazy(...)`。
 *
 * 两边对不上的表现是「菜单点进去白屏」。所以：
 * ① 运行期 `buildRoutes()` 会跳过未登记的 key 并 warn（见控制台）；
 * ② 测试期用 `verifyComponentMap(menus, componentMap)` **双向**对账（蓝图 §8 spec 7）——
 *    `apps/admin` / `apps/platform` 里应各写一条这样的 spec，写法见 admin-ui 的 README。
 */
export const componentMap = defineComponentMap({
  Dashboard: lazy(() => import('../pages/DashboardPage')),
  GoodsList: lazy(() => import('../pages/GoodsListPage')),
  GoodsExport: lazy(() => import('../pages/GoodsExportPage')),
  Billing: lazy(() => import('../pages/BillingPage')),
})
