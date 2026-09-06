import type { ComponentType, ReactNode } from 'react'
import { collectExprCodes, type PermissionExpr } from '@taizan/rbac-core'
import { ForbiddenPage } from './ForbiddenPage'
import { usePerm } from './usePerm'

export interface RequirePermissionProps {
  /**
   * 该页面要求的权限表达式。
   *
   * 允许 `undefined`：`buildRoutes()` 对每一条路由都统一包一层这个组件（结构统一、可断言），
   * 不带权限的菜单传进来就是 `undefined`，此时直接放行。
   */
  code?: PermissionExpr
  /** 覆盖默认 403 页 */
  forbidden?: ComponentType<{ code?: string }>
  children: ReactNode
}

function describeCode(code: PermissionExpr | undefined): string | undefined {
  if (code === undefined) return undefined
  try {
    return collectExprCodes(code).join(' / ')
  } catch {
    return typeof code === 'string' ? code : code.join(' / ')
  }
}

/**
 * 页面级权限闸门（蓝图 §5.2）。
 *
 * 菜单被服务端裁掉时侧边栏里根本看不到入口，但用户可以直接敲 URL；
 * 这一层保证那种情况下看到的是一张**明确的 403**，而不是白屏或 404。
 * 它同样不是安全边界——数据由后端守卫拒绝，这里只负责把「为什么进不去」讲清楚。
 */
export function RequirePermission({ code, forbidden, children }: RequirePermissionProps) {
  const perm = usePerm()
  if (code !== undefined && !perm.has(code)) {
    const Forbidden = forbidden ?? ForbiddenPage
    return <Forbidden code={describeCode(code)} />
  }
  return <>{children}</>
}
