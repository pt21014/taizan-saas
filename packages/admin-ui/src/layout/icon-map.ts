import * as AntdIcons from '@ant-design/icons'
import type { ComponentType } from 'react'

type IconComponent = ComponentType<Record<string, never>>

const ICON_REGISTRY = AntdIcons as unknown as Record<string, IconComponent>

/** `MenuNode.icon` 缺省或未知时的回退图标。 */
const DEFAULT_ICON_KEY = 'AppstoreOutlined'

/**
 * 菜单下发的是图标名字符串（`icon: string`，见 `@taizan/contracts` 的 `MenuNode`），
 * 数据库/代码注册表都不该知道具体用的是哪个 React 组件——这张表把名字动态映射到
 * `@ant-design/icons` 的具体组件。未知的名字打一条 warn 并回退默认图标，不炸整个菜单树。
 */
export function resolveIcon(name?: string): IconComponent {
  if (name) {
    const icon = ICON_REGISTRY[name]
    if (icon) return icon
    console.warn(`[@taizan/admin-ui] 未知图标 "${name}"，已回退为默认图标 ${DEFAULT_ICON_KEY}`)
  }
  return ICON_REGISTRY[DEFAULT_ICON_KEY] as IconComponent
}
