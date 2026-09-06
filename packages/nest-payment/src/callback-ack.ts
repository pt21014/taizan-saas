/**
 * 各渠道要求的**应答报文**。
 *
 * 这一层单独存在，是因为「处理成功」这件事在每家渠道的表达方式都不一样，而表达错了的
 * 后果非常一致：渠道认为你没收到，于是重推——微信最多推 15 次、间隔从 15 秒拉到 4 小时，
 * 一整天都在敲你的接口。
 *
 * - 微信 V3：HTTP 200 + `{"code":"SUCCESS"}`（顶层 `code` 是**字符串**，
 *   所以这条路由必须 `@RawResponse()`，套上 `{code:0,...}` 信封之后微信读到数字 0 判失败）；
 * - 支付宝：HTTP 200 + 纯文本 `success`（不是 JSON）；
 * - 抖音：HTTP 200 + `{"err_no":0,"err_tips":"success"}`。
 *
 * @packageDocumentation
 */

import type { PayChannel } from '@taizan/payment-core'

/** 一份应答：HTTP 状态码 + 报文体。 */
export interface CallbackAck {
  status: number
  body: unknown
}

/** 某个渠道的成功/失败应答。 */
export interface ChannelAckSpec {
  /** 处理成功。一律 200。 */
  success: CallbackAck
  /**
   * 处理失败。
   *
   * @param message - 给渠道看的原因（微信只收 ≤32 字符，这里自己截）
   * @param status - HTTP 状态码：验签失败给 400（**别给 5xx**，那会让渠道以为是我们
   *   临时挂了而继续重推一个永远验不过的报文），处理器抛错给 500（要的就是重推）
   */
  failure(message: string, status: number): CallbackAck
}

const wechat: ChannelAckSpec = {
  success: { status: 200, body: { code: 'SUCCESS', message: '成功' } },
  failure: (message, status) => ({
    status,
    body: { code: 'FAIL', message: message.slice(0, 32) },
  }),
}

const alipay: ChannelAckSpec = {
  success: { status: 200, body: 'success' },
  failure: (_message, status) => ({ status, body: 'fail' }),
}

const douyin: ChannelAckSpec = {
  success: { status: 200, body: { err_no: 0, err_tips: 'success' } },
  failure: (message, status) => ({ status, body: { err_no: 1, err_tips: message.slice(0, 64) } }),
}

/**
 * `OFFLINE` 没有真实渠道（是平台后台手工核销），但路由存在时总得有个应答，
 * 用微信那套形状即可——它是本仓唯一被真实第三方读过的形状。
 */
export const DEFAULT_CHANNEL_ACKS: Readonly<Record<PayChannel, ChannelAckSpec>> = {
  WECHAT: wechat,
  ALIPAY: alipay,
  DOUYIN: douyin,
  OFFLINE: wechat,
}

/** 取某个渠道的应答规格，允许装配期覆盖。 */
export function ackSpecOf(
  channel: PayChannel,
  overrides?: Partial<Record<PayChannel, ChannelAckSpec>>,
): ChannelAckSpec {
  return overrides?.[channel] ?? DEFAULT_CHANNEL_ACKS[channel]
}
