/**
 * 支付协议层的公共类型。**全仓金额一律用「分」表示的整数**（蓝图 §3.1），
 * 字段名以 `Cents` 结尾；两个来源项目（xiaodian / knowledge）也都是分，搬过来无需换算。
 */

/**
 * 支付渠道。取值与 Prisma 的 `PayChannel` enum **逐字符一致**（蓝图 §3.2）：
 * 这里是纯 TS 字面量联合，不 import Prisma，好让本包在裸 node 环境跑单测。
 *
 * 加渠道时两处都要改：Prisma schema 的 enum 与这里的联合，
 * 少改一处的表现是「数据库存得进去、代码里 narrow 不到」。
 */
export type PayChannel = 'WECHAT' | 'ALIPAY' | 'DOUYIN' | 'OFFLINE'

/** {@link PayChannel} 的运行时取值表，供校验/遍历用。 */
export const PAY_CHANNELS = ['WECHAT', 'ALIPAY', 'DOUYIN', 'OFFLINE'] as const

/** 判断任意值是不是合法的 {@link PayChannel}。 */
export function isPayChannel(value: unknown): value is PayChannel {
  return typeof value === 'string' && (PAY_CHANNELS as readonly string[]).includes(value)
}

/**
 * 交易状态（各渠道状态的最小公共集）。
 *
 * 各 Provider 负责把渠道自己的状态字符串映射到这几个值——**映射写在 Provider 里**，
 * 而不是让上层 `if (tradeState === 'USERPAYING')` 到处判断微信特有的枚举。
 */
export type TradeState =
  /** 未支付（含渠道侧查无此单：查不到就是没付过） */
  | 'NOTPAY'
  /** 支付中（用户正在输密码/银行处理中） */
  | 'PAYING'
  /** 支付成功 */
  | 'SUCCESS'
  /** 已关单 */
  | 'CLOSED'
  /** 已撤销 */
  | 'REVOKED'
  /** 已（部分）退款 */
  | 'REFUND'
  /** 支付失败 */
  | 'FAIL'

/**
 * 归一化后的支付回调事件（蓝图 §4.12）。
 *
 * `raw` 保留渠道原始报文（解密后的明文对象），落库存档用；
 * 领域处理器只该读前面那几个归一化字段，读 `raw` 就意味着又和某个渠道绑死了。
 *
 * 相对蓝图代码块多出的两个字段是 `channel` 与 `payer`：前者让统一回调控制器
 * 不必再从路由参数里回捞渠道，后者是「谁付的钱」，发权益/记账都要用。
 */
export interface CallbackEvent {
  kind: 'PAY_SUCCESS' | 'PAY_FAIL'
  /** 事件来自哪个渠道。 */
  channel: PayChannel
  /** 商户订单号（我们生成的，见 `out-trade-no.ts`）。 */
  outTradeNo: string
  /** 渠道侧交易号。**幂等键就是它**（蓝图 §4.12）。 */
  transactionId: string
  /** 实付金额（分）。 */
  amountCents: number
  /** 支付完成时间。渠道没给就用回调到达时间兜底。 */
  paidAt: Date
  /** 付款人标识（微信 openid / 支付宝 buyerId）。 */
  payer?: PayerRef
  /** 渠道原始报文（已解密）。 */
  raw: unknown
}

/**
 * 归一化后的退款回调事件。
 *
 * 退款没有「transactionId 幂等」那么干净的键，幂等要用 `outRefundNo`——
 * 一笔支付可以退多次，用 transactionId 去重会把第二次退款吞掉。
 */
export interface RefundEvent {
  kind: 'REFUND_SUCCESS' | 'REFUND_FAIL' | 'REFUND_CLOSED'
  channel: PayChannel
  /** 原支付的商户订单号。 */
  outTradeNo: string
  /** 商户退款单号。**退款回调的幂等键**。 */
  outRefundNo: string
  /** 渠道侧退款单号。 */
  refundId: string
  /** 本次退款金额（分）。 */
  refundCents: number
  /** 原订单总额（分）。渠道没给则为 0。 */
  totalCents: number
  /** 退款成功时间；未成功为 `null`。 */
  successAt: Date | null
  raw: unknown
}

/** 退款申请。 */
export interface RefundReq {
  /** 原支付的商户订单号。 */
  outTradeNo: string
  /** 商户退款单号（我们生成，同一笔退款重试必须复用，否则会退两次钱）。 */
  outRefundNo: string
  /** 原订单总额（分）。 */
  totalCents: number
  /** 本次退款金额（分）。 */
  refundCents: number
  /** 退款原因（渠道会展示给用户）。 */
  reason?: string
  /** 退款结果回调地址。不传则只能靠主动查退款单。 */
  notifyUrl?: string
  /** 渠道特有的附加参数。 */
  extra?: Record<string, unknown>
}

/** 渠道受理退款后的状态。**受理 ≠ 到账**，`PROCESSING` 要靠回调或轮询确认。 */
export type RefundState = 'SUCCESS' | 'PROCESSING' | 'ABNORMAL' | 'CLOSED'

/** 退款受理结果。 */
export interface RefundRes {
  /** 渠道侧退款单号。 */
  refundId: string
  status: RefundState
  /** 渠道确认的退款金额（分）。 */
  refundCents: number
  raw?: unknown
}

/**
 * 付款人标识。
 *
 * 做成 `{ kind, value }` 而不是裸字符串，是因为 openid 与 buyerId 长得一样但**不能互换**：
 * 拿微信 openid 去支付宝下单不会报类型错，只会在运行时被渠道拒单。
 * `kind: 'none'` 用于 Native 扫码 / H5 这类下单时还不知道付款人是谁的场景。
 */
export interface PayerRef {
  kind: 'openid' | 'buyerId' | 'none'
  value?: string
}
