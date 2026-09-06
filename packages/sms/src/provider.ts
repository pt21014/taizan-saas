/**
 * 短信 Provider 的统一形状。
 *
 * 每家厂商的签名算法完全不同（见 `providers/*`），但对上层暴露的接口必须一样：
 * `registry.sendWithFallback` 才能不关心具体是哪家、把主厂商换成备用厂商。
 */

/** 一次发送请求。 */
export interface SmsSendRequest {
  /** 大陆手机号，不带 +86，纯数字。是否合法由调用方先过 `phone.ts` 的校验。 */
  phone: string
  /** 模板 key（业务侧的抽象名，不是厂商侧的模板 id）。 */
  templateKey: string
  /** 模板参数，按变量名传（顺序由 `templates.ts` 从 `paramOrder` 计算，不用关心）。 */
  params: Record<string, string>
  /** 短信签名（短信头部的【签名】），不传则用 provider 配置里的默认签名。 */
  signName?: string
}

/** 一次发送结果。**不抛异常**——网络异常、厂商拒绝都归一成这个结构，调用方靠它决定扣不扣额度、要不要切备用。 */
export interface SmsResult {
  ok: boolean
  /** 实际发送用的 provider 名。 */
  provider: string
  /** 厂商侧的流水号（腾讯云 SerialNo / 阿里云 BizId），供控制台核对。 */
  vendorRef?: string
  /** 失败原因；`ok: true` 时不该有。 */
  error?: string
  /** 厂商原始响应，供排障用，不建议直接展示给用户。 */
  raw?: unknown
}

/**
 * 短信厂商 Provider。
 *
 * `TConfig` 是这家厂商特有的配置形状（腾讯云要 secretId/secretKey/region，
 * 阿里云要 accessKeyId/accessKeySecret/signName），刻意不统一成一个大而全的配置对象——
 * 那样每加一家厂商都要给所有厂商的配置类型加一个永远用不到的可选字段。
 */
export interface SmsProvider<TConfig = unknown> {
  /** provider 名，registry 按它索引，也是 `SmsResult.provider` 的值。 */
  readonly name: string
  send(req: SmsSendRequest, cfg: TConfig): Promise<SmsResult>
}
