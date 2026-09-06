import { useMemo } from 'react'
import { evaluatePermission, type PermissionExpr } from '@taizan/rbac-core'
import { useSession } from '../session'

/** {@link usePerm} 返回的判定器。 */
export interface PermChecker {
  /**
   * 求值一个权限表达式：`'goods:write'`、`'goods:write|goods:list'`（或）、
   * `['goods:write', 'goods:delete']`（与）。语义与后端 `@RequirePermission` 完全一致
   * （同一个 `@taizan/rbac-core.evaluatePermission`），所以前端藏按钮和后端拒请求
   * 不会出现「前端以为有、后端说没有」的分歧。
   */
  has(expr: PermissionExpr): boolean
  /** 全部满足 */
  hasAll(codes: readonly string[]): boolean
  /** 任一满足 */
  hasAny(codes: readonly string[]): boolean
  /** 当前已展开的权限点集合（来自 `/auth/bootstrap`） */
  readonly codes: ReadonlySet<string>
}

/**
 * 按钮级权限判定（蓝图 §5.2）。数据源是 `useSession().permissions`——
 * 那是 `/api/admin/auth/bootstrap` 下发的、**已经展开过角色与通配**的权限点列表，
 * 前端不做任何角色推导，也不给店主开后门（店主的权限由服务端展开成具体 code 后下发）。
 *
 * 表达式非法（拼错成 `'goodsWrite'`、误写通配 `'goods:*'`）时 `rbac-core` 会抛错。
 * 这里**吞掉异常并返回 false**：一个写错的权限码不该把整个页面炸成白屏，
 * 而「藏起来」是这两种失败方向里安全的那一个。同时打一条 error 到控制台，
 * 配合 `perm-usage.spec.ts`（扫源码里的 code 是否都在后端注册表里）就能在测试期抓住。
 */
export function usePerm(): PermChecker {
  const permissions = useSession((s) => s.permissions)

  return useMemo<PermChecker>(() => {
    const codes = new Set(permissions)
    const has = (expr: PermissionExpr): boolean => {
      try {
        return evaluatePermission(expr, codes)
      } catch (err) {
        console.error(
          `[@taizan/admin-ui] usePerm().has() 收到非法权限表达式 ${JSON.stringify(expr)}：` +
            `${(err as Error).message}（按「无权限」处理）`,
        )
        return false
      }
    }
    return {
      has,
      hasAll: (list) => (list.length === 0 ? true : has([...list])),
      hasAny: (list) => (list.length === 0 ? true : has(list.join('|'))),
      codes,
    }
  }, [permissions])
}
