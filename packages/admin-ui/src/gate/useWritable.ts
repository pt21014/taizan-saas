import { useSession } from '../session'

/**
 * 只读闸门（蓝图 §4.5/§5.2）：套餐到期后 `tenant.readonly === true`，表单提交按钮应自动
 * 禁用。续费白名单页面（账单页本身）不该被这个钩子禁掉——那种页面根本不应该调用它。
 *
 * `tenant` 还没加载出来时（bootstrap 尚未完成）乐观地返回 `true`，避免刷新瞬间
 * 所有按钮先闪一下禁用状态。
 */
export function useWritable(): boolean {
  return useSession((s) => s.tenant?.readonly !== true)
}
