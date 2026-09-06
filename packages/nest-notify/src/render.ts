/**
 * 模板变量渲染：把 `{{var}}` 占位符替换成 `vars` 里的值。
 *
 * 缺变量直接抛错，**不把 `{{var}}` 原样留在发出去的内容里**——那样用户收到的
 * 是一条"看起来正常、其实内容错的"通知，比发送失败更难被发现。
 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/**
 * @throws 正文里引用的变量在 `vars` 里找不到时抛
 */
export function renderTemplate(content: string, vars: Record<string, string>): string {
  return content.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(`[@taizan/nest-notify] 模板参数缺失："${name}"（正文里引用了它）`)
    }
    return value
  })
}
