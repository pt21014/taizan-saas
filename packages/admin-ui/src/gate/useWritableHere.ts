import { useLocation } from 'react-router-dom'
import { useWritable } from './useWritable'

/**
 * 前端侧的**续费白名单**路由前缀。
 *
 * 对应后端 `@taizan/billing-rules` 的 `ALWAYS_WRITABLE_PREFIXES`（`/api/admin/billing` 等）：
 * 后端保证这些接口在只读态下照样可写，前端就不能把这些页面上的按钮禁掉——
 * 否则就是蓝图 §4.5 点名的那个死循环：「到期 → 只读 → 续不了费 → 永远到期」。
 */
export const RENEWAL_PATH_PREFIXES: readonly string[] = ['/billing', '/plan', '/order/renew']

/** 判断一个前端路由是否属于续费白名单（只读态下不禁用提交）。 */
export function isRenewalRoute(pathname: string, prefixes = RENEWAL_PATH_PREFIXES): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * 「**当前这个页面**能不能写」——`useWritable()` 叠上续费白名单。
 *
 * `useWritable()` 只回答「租户是不是只读态」；账单页在只读态下必须仍然能提交，
 * 所以 `<CrudDrawerForm>`、以及任何自己接闸门的提交按钮，都应该用这个钩子而不是
 * 直接用 `useWritable()`。
 *
 * @param extraWritablePrefixes - 额外的白名单前缀（应用自己的续费/工单页等）
 */
export function useWritableHere(extraWritablePrefixes: readonly string[] = []): boolean {
  const writable = useWritable()
  const { pathname } = useLocation()
  if (writable) return true
  return isRenewalRoute(pathname, [...RENEWAL_PATH_PREFIXES, ...extraWritablePrefixes])
}
