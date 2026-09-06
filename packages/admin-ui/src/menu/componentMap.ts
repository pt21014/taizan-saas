import type { ComponentType, LazyExoticComponent } from 'react'

/**
 * `componentKey → 组件` 的映射表（蓝图 §4.4）。
 *
 * 服务端只下发 `componentKey`（不下发前端文件路径，避免把前端目录结构写进数据库），
 * 由前端应用（`apps/admin` / `apps/platform` 各一份 `routes/component-map.ts`）
 * 把 key 映射到 `React.lazy()` 出来的页面组件。
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
   映射表要装下任意 props 形状的页面组件。收窄成 `ComponentType<Record<string, unknown>>`
   会让「带自定义 props 的页面组件」登记不进来；而 `buildRoutes` 渲染时从不传 props，
   所以这个 `any` 只活在类型位置，运行期没有任何东西依赖它。 */
export type PageComponent = ComponentType<any>
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 一份已注册的组件映射表。 */
export type ComponentMap = Record<string, LazyExoticComponent<PageComponent>>

/**
 * componentKey 的合法形状：PascalCase（`GoodsList`、`PlatformTenantList`）。
 *
 * 刻意不允许 `goods-list` / `goods.list` / `GoodsList2Page ` 这类写法：
 * key 会同时出现在后端菜单注册表和前端映射表两处，两边靠肉眼对齐，
 * 大小写与分隔符各写各的就一定会漂移（spec 7 守的就是这个）。
 */
const COMPONENT_KEY_PATTERN = /^[A-Z][A-Za-z0-9]*$/

/**
 * 注册一份组件映射表：校验每个 key 的格式，然后冻结。
 *
 * 冻结是为了让「运行期往映射表里塞一个组件」变成一个立刻炸出来的错误——
 * 动态注册意味着路由表在不同时刻不一样，spec 7 的静态对账就失去意义了。
 *
 * @throws key 不是 PascalCase、或值不是组件时抛出
 *
 * @example
 * ```ts
 * export const componentMap = defineComponentMap({
 *   GoodsList: lazy(() => import('../pages/goods/GoodsListPage')),
 * })
 * ```
 */
export function defineComponentMap<const T extends ComponentMap>(map: T): Readonly<T> {
  for (const [key, value] of Object.entries(map)) {
    if (!COMPONENT_KEY_PATTERN.test(key)) {
      throw new Error(
        `[@taizan/admin-ui] componentKey "${key}" 不合法：必须是 PascalCase（如 'GoodsList'）`,
      )
    }
    if (value === null || value === undefined) {
      throw new Error(
        `[@taizan/admin-ui] componentKey "${key}" 的值为空：忘了 lazy(() => import(...)) 吗？`,
      )
    }
  }
  return Object.freeze(map)
}

/** 判断一个字符串是否是合法的 componentKey 形状（供 spec 7 与生成器复用）。 */
export function isValidComponentKey(key: string): boolean {
  return COMPONENT_KEY_PATTERN.test(key)
}
