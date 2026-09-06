import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useSession } from '../session'

/** 登录成功后要跳回的原地址，挂在登录页 URL 的这个 query 参数上。 */
export const RETURN_TO_PARAM = 'returnTo'

export interface RequireAuthProps {
  /** 未登录时跳去的登录页路径，缺省 `/login` */
  loginPath?: string
  children: ReactNode
}

/**
 * 登录闸门（蓝图 §5.2）：没有 token 就跳登录页，并把当前地址记进 `?returnTo=`。
 *
 * 记 `returnTo` 不是锦上添花：后台的深链接（客服发过来的「你看这个订单」）如果
 * 登录后一律落到工作台，用户还得自己再找一遍——而他多半找不到。
 *
 * 同时写进 query 与 `location.state`：query 扛得住整页刷新（`onUnauthorized` 里的
 * `window.location.href = loginPath` 就是整页跳转，state 会丢），state 则不暴露在
 * 地址栏里，登录页两个都读得到（见 {@link readReturnTo}）。
 */
export function RequireAuth({ loginPath = '/login', children }: RequireAuthProps) {
  const token = useSession((s) => s.token)
  const location = useLocation()

  if (!token) {
    const returnTo = `${location.pathname}${location.search}`
    const target =
      returnTo === '/' || returnTo === loginPath
        ? loginPath
        : `${loginPath}?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`
    return <Navigate to={target} replace state={{ [RETURN_TO_PARAM]: returnTo }} />
  }

  return <>{children}</>
}

/**
 * 从登录页所在的 location 里读出 `returnTo`。登录成功后 `navigate(readReturnTo(...) ?? '/')`。
 *
 * 只接受站内**绝对路径**（以单个 `/` 开头）：`returnTo=https://evil.example` 这种
 * 开放重定向是登录页最常见的一个洞，拦在读取这一侧比拦在写入侧可靠。
 */
export function readReturnTo(search: string, state?: unknown): string | null {
  const fromState =
    state !== null && typeof state === 'object' && RETURN_TO_PARAM in state
      ? (state as Record<string, unknown>)[RETURN_TO_PARAM]
      : undefined
  const raw =
    new URLSearchParams(search).get(RETURN_TO_PARAM) ??
    (typeof fromState === 'string' ? fromState : null)
  if (raw === null) return null
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  return raw
}
