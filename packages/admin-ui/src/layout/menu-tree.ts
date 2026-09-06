import { createElement } from 'react'
import type { MenuNode } from '@taizan/contracts'
import type { MenuProps } from 'antd'
import { resolveIcon } from './icon-map'

type AntdMenuItem = NonNullable<MenuProps['items']>[number]

/**
 * `MenuNode[]`（服务端下发、已按 权限 ∩ 套餐 features ∩ 显式禁用 裁剪过）→ antd `Menu` 的
 * `items`。`BUTTON` 类型节点只用于按钮级权限点（T3-2 的 `usePerm()`），侧边栏不画它。
 */
export function buildAntdMenuItems(menus: MenuNode[]): AntdMenuItem[] {
  return menus
    .filter((node) => node.type !== 'BUTTON')
    .map((node) => {
      const icon = createElement(resolveIcon(node.icon))
      const children = node.children ? buildAntdMenuItems(node.children) : undefined
      return {
        key: node.path ?? node.key,
        icon,
        label: node.title,
        children: children && children.length > 0 ? children : undefined,
      } as AntdMenuItem
    })
}

interface Trail {
  keys: string[]
  nodes: MenuNode[]
}

/** 从根找到当前路径对应的那一支，用于侧边栏高亮展开与面包屑渲染。 */
export function findMenuTrail(menus: MenuNode[], pathname: string): Trail {
  for (const node of menus) {
    if (node.path === pathname) {
      return { keys: [node.path], nodes: [node] }
    }
    if (node.children) {
      const sub = findMenuTrail(node.children, pathname)
      if (sub.nodes.length > 0) {
        return { keys: [node.path ?? node.key, ...sub.keys], nodes: [node, ...sub.nodes] }
      }
    }
  }
  return { keys: [], nodes: [] }
}
