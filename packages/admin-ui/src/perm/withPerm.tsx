import type { ComponentType } from 'react'
import type { PermissionExpr } from '@taizan/rbac-core'
import { usePerm } from './usePerm'

/**
 * `<Perm>` 的高阶组件写法：把一个已有组件包成「没权限就不渲染」。
 *
 * 适用于第三方组件或已经写好的按钮组件——不方便在 JSX 里外套一层标签时用它。
 *
 * ```tsx
 * const ExportButton = withPerm(Button, 'goods:export')
 * <ExportButton onClick={doExport}>导出</ExportButton>
 * ```
 */
export function withPerm<P extends object>(
  Component: ComponentType<P>,
  code: PermissionExpr,
): ComponentType<P> {
  function PermGuarded(props: P) {
    const perm = usePerm()
    if (!perm.has(code)) return null
    return <Component {...props} />
  }
  const name = Component.displayName ?? Component.name ?? 'Component'
  PermGuarded.displayName = `withPerm(${name})`
  return PermGuarded
}
