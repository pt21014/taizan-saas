/**
 * 通知抽象的公共类型（蓝图 §4.13）。
 *
 * @packageDocumentation
 */

/** 四个通知通道。 */
export type NotifyChannelKind = 'SMS' | 'INBOX' | 'MP_TEMPLATE' | 'APP_PUSH'

/**
 * 接收方。哪个字段必填由具体通道决定：SMS 要 `phone`，MP_TEMPLATE/APP_PUSH 通常
 * 要 `openId`/`deviceToken`，INBOX 只要 `userId`（站内信写给哪个用户）。
 * 做成一个"够用的并集"而不是每个通道各一套参数，是因为同一条业务通知
 * （比如"套餐即将到期"）经常要同时投给好几个通道，`to` 只填一次。
 */
export interface NotifyTarget {
  phone?: string
  openId?: string
  email?: string
  deviceToken?: string
  userId?: string
}

/** 渲染好的一条通知消息，交给某个 {@link NotifyChannelDriver} 去发。 */
export interface NotifyMessage {
  templateKey: string
  title: string
  /** 已经把 `{{var}}` 占位符替换成具体值之后的正文。 */
  content: string
  vars: Record<string, string>
  to: NotifyTarget
  tenantId?: string
  /** 渠道侧模板 id（短信签名模板、微信订阅消息模板等），只有部分渠道用得到。 */
  providerTemplateId?: string
}

/** 通道内部一次具体尝试（例如 SMS 通道里某一家厂商的一次调用）。 */
export interface NotifyAttempt {
  ok: boolean
  /** 例如厂商名（`tencent-tc3`/`aliyun-rpc`）或其它可读标识。 */
  label?: string
  vendorRef?: string
  error?: string
}

/**
 * 一次发送结果。**不抛异常**——失败与否由 `ok` 表达，`NotifyService` 靠它决定要不要
 * 进队列重试。
 */
export interface NotifyResult {
  ok: boolean
  channel: NotifyChannelKind
  vendorRef?: string
  error?: string
  /**
   * 通道内部的多次尝试明细（目前只有 SMS 通道会填：主厂商失败切备用时，这里有
   * 两条）。`NotifyRecord` 落库时会按这个数组展开成多条记录——一条通知底下
   * 换过厂商，排障时要能看到每一次都失败在哪，不能只留最后一次。
   */
  attempts?: NotifyAttempt[]
}

/** 一个通道的发送驱动。 */
export interface NotifyChannelDriver {
  readonly kind: NotifyChannelKind
  send(message: NotifyMessage): Promise<NotifyResult>
}

/** `NotifyService.send()` 的入参。 */
export interface NotifySendRequest {
  /** 归属租户；不传即平台域通知（发给平台管理员，或发给租户主体但由平台发起）。 */
  tenantId?: string
  templateKey: string
  to: NotifyTarget
  vars: Record<string, string>
  /**
   * 尝试哪些通道。不传则用模板登记的默认通道（见 `template-source.ts`）。
   *
   * - `fallback` 不为 `true` 时：**广播**——列表里每个通道都独立尝试一次，
   *   返回值里能看到每个通道各自的结果（例如"重要通知"同时发短信 + 站内信）。
   * - `fallback: true` 时：**降级**——按列表顺序尝试，第一个成功就停，
   *   只返回实际尝试过的那些（短信厂商余额不足切阿里云属于这一层之下、
   *   `@taizan/sms` registry 自己的主备切换；这里的降级是跨通道的，
   *   例如短信通道整体失败后改投站内信）。
   */
  channels?: NotifyChannelKind[]
  fallback?: boolean
}

export interface NotifyService {
  send(req: NotifySendRequest): Promise<NotifyResult[]>
}
