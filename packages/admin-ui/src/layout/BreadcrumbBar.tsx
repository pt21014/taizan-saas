import { Breadcrumb } from 'antd'
import { useLocation } from 'react-router-dom'
import { useSession } from '../session'
import { findMenuTrail } from './menu-tree'

/** 顶栏面包屑：从当前路径反查菜单树，画出「上级目录 > 当前页」。 */
export function BreadcrumbBar() {
  const menus = useSession((s) => s.menus)
  const location = useLocation()
  const trail = findMenuTrail(menus, location.pathname)

  if (trail.nodes.length === 0) return null

  return (
    <Breadcrumb
      items={trail.nodes.map((node) => ({ title: node.title }))}
      style={{ margin: '12px 0' }}
    />
  )
}
