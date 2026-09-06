/**
 * 模板契约：业务侧的 `templateKey`（例如 `sms.login-code`）→ 厂商侧的模板 id + 参数顺序。
 *
 * **两家厂商的模板都是按位置替换 `{1}`/`${name}`，不是按变量名**——对象的键序在 JS 里
 * 不保证与写代码时的顺序一致（`for...in`/`Object.keys` 对数字类字符串键会重排），
 * 所以参数必须显式声明顺序，再在发送前按这个顺序摊平成数组。顺序错了发出去的是一条
 * 「内容错乱但状态是发送成功」的短信——两家 API 都不会告诉你参数放错了地方。
 */

/** 一个模板 key 对应的定义。 */
export interface SmsTemplateDef {
  /** 厂商侧的模板 id（腾讯云的 TemplateId / 阿里云的 TemplateCode）。 */
  providerTemplateId: string
  /** 变量按厂商模板里 `{1}`/`{2}` 的顺序列出的变量名。 */
  paramOrder: string[]
}

/** `templateKey → 定义` 的登记表。 */
export type SmsTemplateRegistry = Record<string, SmsTemplateDef>

/**
 * 按 `paramOrder` 把 `params` 摊平成数组，供厂商的 `TemplateParamSet` 使用。
 *
 * @throws `paramOrder` 里声明的变量在 `params` 里找不到时抛——宁可发不出去，
 *   也不要把 `undefined` 悄悄拼进短信内容里发给用户。
 */
export function resolveTemplateParams(
  def: SmsTemplateDef,
  params: Record<string, string>,
): string[] {
  return def.paramOrder.map((key) => {
    const value = params[key]
    if (value === undefined) {
      throw new Error(
        `[@taizan/sms] 模板参数缺失："${key}"（provider 模板 ${def.providerTemplateId} 需要它）`,
      )
    }
    return value
  })
}

/** 从登记表里取一个模板定义。 */
export function requireTemplate(
  registry: SmsTemplateRegistry,
  templateKey: string,
): SmsTemplateDef {
  const def = registry[templateKey]
  if (!def) {
    throw new Error(`[@taizan/sms] 未登记的模板 key："${templateKey}"`)
  }
  return def
}
