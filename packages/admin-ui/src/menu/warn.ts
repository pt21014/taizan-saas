/**
 * 未注册 componentKey 的告警去重。
 *
 * process-local: 只是一个「这条 warn 已经打过了」的备忘录，不是业务状态。
 * 不去重的话 `renderMenus()` 每次重渲染都会再刷一遍控制台，真正的报错反而被淹掉。
 */
const warned = new Set<string>()

/** 打一条「componentKey 未注册」的告警（同一个 key + 同一处调用点只打一次）。 */
export function warnUnknownComponentKey(componentKey: string, where: string): void {
  const token = `${where}:${componentKey}`
  if (warned.has(token)) return
  warned.add(token)
  console.warn(
    `[@taizan/admin-ui] ${where}：菜单里的 componentKey "${componentKey}" 不在 componentMap 里，` +
      `已跳过该节点（不渲染空白页）。请在 apps/*/src/routes/component-map.ts 里登记它，` +
      `或用 verifyComponentMap() 在测试里对账（蓝图 §8 spec 7）。`,
  )
}

/** 打一条「菜单有 path 却没有 componentKey」的告警。 */
export function warnMissingComponentKey(menuKey: string, where: string): void {
  const token = `${where}:menu:${menuKey}`
  if (warned.has(token)) return
  warned.add(token)
  console.warn(
    `[@taizan/admin-ui] ${where}：菜单 "${menuKey}" 是 MENU 类型且有 path，却没有 componentKey，` +
      `已跳过（否则点进去是一张白屏）。`,
  )
}

/** 清空告警备忘录。**仅供测试使用**——业务代码调它没有任何意义。 */
export function resetComponentKeyWarnings(): void {
  warned.clear()
}
