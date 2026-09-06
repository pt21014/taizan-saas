import type { MenuProps } from 'antd'
import { buildAntdMenuItems } from '../layout/menu-tree'
import type { ComponentMap } from './componentMap'
import type { RoutableMenuNode } from './types'
import { warnMissingComponentKey, warnUnknownComponentKey } from './warn'

type AntdMenuItem = NonNullable<MenuProps['items']>[number]

/**
 * 把菜单树裁成「侧边栏真的画得出来」的那一部分（纯函数，便于单测）。
 *
 * 裁掉三类：
 * - `BUTTON` 节点：它只是按钮级权限点的载体（`usePerm()` 用），从来不是一个菜单项；
 * - `componentKey` 不在映射表里的 `MENU`：点进去是白屏，不如不给入口（与 `buildRoutes` 一致）；
 * - 裁完之后一个子节点都不剩的 `DIR`：一个点开空空如也的分组比没有更让人困惑。
 *
 * 不传 `componentMap` 时只做前两类里的 BUTTON 过滤——`<AppShell>` 早于路由装配存在，
 * 它不必知道映射表。
 */
export function filterRenderableMenus(
  menus: readonly RoutableMenuNode[],
  componentMap?: ComponentMap,
): RoutableMenuNode[] {
  const out: RoutableMenuNode[] = []
  for (const node of menus) {
    if (node.type === 'BUTTON') continue

    if (node.type === 'MENU' && componentMap !== undefined) {
      const componentKey = node.componentKey
      if (componentKey === undefined || componentKey.length === 0) {
        if (node.path !== undefined && node.path.length > 0) {
          warnMissingComponentKey(node.key, 'renderMenus()')
          continue
        }
      } else if (componentMap[componentKey] === undefined) {
        warnUnknownComponentKey(componentKey, 'renderMenus()')
        continue
      }
    }

    const children =
      node.children !== undefined && node.children.length > 0
        ? filterRenderableMenus(node.children, componentMap)
        : undefined

    if (node.type === 'DIR' && (children === undefined || children.length === 0)) continue

    out.push(children === undefined ? node : { ...node, children })
  }
  return out
}

/**
 * 服务端下发的菜单树 → antd `<Menu>` 的 `items`（蓝图 §5.2）。
 *
 * ```tsx
 * <Menu mode="inline" items={renderMenus(menus, componentMap)} onClick={({ key }) => navigate(key)} />
 * ```
 *
 * antd 菜单项的 `key` 用节点的 `path`（没有 path 的分组退回 `key`），
 * 这样 `onClick` 直接 `navigate(key)` 就行——`<AppShell>` 用的就是这个约定。
 */
export function renderMenus(
  menus: readonly RoutableMenuNode[],
  componentMap?: ComponentMap,
): AntdMenuItem[] {
  return buildAntdMenuItems(filterRenderableMenus(menus, componentMap))
}
