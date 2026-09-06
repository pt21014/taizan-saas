import type { ReactNode } from 'react'
import type { PermissionExpr } from '@taizan/rbac-core'
import { usePerm } from './usePerm'

export interface PermProps {
  /** 权限表达式，与后端 `@RequirePermission` 同名同语义 */
  code: PermissionExpr
  /** 无权限时渲染什么，缺省什么都不渲染 */
  fallback?: ReactNode
  children: ReactNode
}

/**
 * 按钮/区块级权限包裹（蓝图 §5.2）。
 *
 * ```tsx
 * <Perm code="goods:write">
 *   <Button type="primary" onClick={form.open}>新增</Button>
 * </Perm>
 * ```
 *
 * 注意这是**体验层**的隐藏，不是安全边界：真正拒绝请求的是后端守卫。
 * 两边用同一个 code 是硬要求——前端藏了后端没拦，等于没拦；后端拦了前端没藏，
 * 用户会一直点一个必然失败的按钮。
 */
export function Perm({ code, fallback = null, children }: PermProps) {
  const perm = usePerm()
  return <>{perm.has(code) ? children : fallback}</>
}
