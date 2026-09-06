/**
 * 直连商户 / 服务商（partner）两种模式的下单报文与路径构造。**纯函数，不发请求。**
 *
 * 搬自 xiaodian `libs/wechatpay/src/wechatpay-client.ts` 里 jsapi / native / h5 三个方法的
 * 报文分支，和 knowledge `wechat-partner.service.ts` 的 `sp_appid / sub_appid / sub_openid`
 * 那段注释——那段是拿生产事故换来的，原样保留。
 *
 * ## 服务商模式的三个坑
 *
 * 1. **签名用服务商的商户号与证书**，`sub_mchid` 只出现在报文里；
 * 2. **`openid` 归属哪个 appid，就必须用对应的字段**：商家自己的小程序 → `sub_appid` +
 *    `payer.sub_openid`；服务商公众号 → `payer.sp_openid`。搞反了微信直接拒单；
 * 3. **分账标记只能在下单时打**（`settle_info.profit_sharing`），支付完再想分账已经来不及；
 *    但没开通分账时打了标记，钱会被冻到分账超时，商家看到「收了款提不出来」会立刻投诉。
 */
import { PAYMENT_ERROR, PaymentError, type PayerRef, type TradeState } from '@taizan/payment-core'

import type { TradeType, WechatPayConfig } from './types'

/** 统一下单请求（微信侧的形状，比蓝图的 `CreateOrderReq` 多几个渠道特有字段）。 */
export interface PlaceOrderInput {
  outTradeNo: string
  /** 金额（分）。 */
  amountCents: number
  /** 商品描述。微信上限 127 字符，这里会截断而不是报错。 */
  description: string
  notifyUrl: string
  /** JSAPI 必填：付款人 openid。 */
  openId?: string
  /** H5 必填：真实用户 IP。缺了微信回 `PARAM_ERROR`，指到 `scene_info`。 */
  payerClientIp?: string
  /** 附加数据，回调原样返回。 */
  attach?: string
  /** 是否打分账标记。**只能下单时打**。 */
  profitSharing?: boolean
  /** 订单失效时间（RFC3339）。 */
  timeExpire?: string
}

const TRADE_PATH: Record<TradeType, { direct: string; partner: string }> = {
  JSAPI: { direct: '/v3/pay/transactions/jsapi', partner: '/v3/pay/partner/transactions/jsapi' },
  NATIVE: { direct: '/v3/pay/transactions/native', partner: '/v3/pay/partner/transactions/native' },
  H5: { direct: '/v3/pay/transactions/h5', partner: '/v3/pay/partner/transactions/h5' },
}

/** 下单接口路径（按模式与支付方式选）。 */
export function transactionPath(cfg: WechatPayConfig, tradeType: TradeType): string {
  const entry = TRADE_PATH[tradeType]
  return cfg.mode === 'PARTNER' ? entry.partner : entry.direct
}

/**
 * 构造下单报文。
 *
 * 返回的是**对象**；调用方必须 `JSON.stringify` **一次**，然后把那串字节同时用于签名与发送——
 * 签一份、发另一份是签名失败最常见的原因。
 */
export function buildTransactionBody(
  cfg: WechatPayConfig,
  input: PlaceOrderInput,
  tradeType: TradeType,
): Record<string, unknown> {
  if (tradeType === 'JSAPI' && !input.openId) {
    throw PaymentError.of(PAYMENT_ERROR.BAD_REQUEST, '[@taizan/wechatpay] JSAPI 下单缺少 openId')
  }
  if (tradeType === 'H5' && !input.payerClientIp) {
    throw PaymentError.of(
      PAYMENT_ERROR.BAD_REQUEST,
      '[@taizan/wechatpay] H5 下单缺少 payerClientIp（scene_info.payer_client_ip 必填）',
    )
  }

  const common: Record<string, unknown> = {
    description: input.description.slice(0, 127),
    out_trade_no: input.outTradeNo,
    notify_url: input.notifyUrl,
    amount: { total: input.amountCents, currency: 'CNY' },
  }
  if (input.attach) common['attach'] = input.attach
  if (input.timeExpire) common['time_expire'] = input.timeExpire
  if (input.profitSharing) common['settle_info'] = { profit_sharing: true }
  if (tradeType === 'H5') {
    common['scene_info'] = { payer_client_ip: input.payerClientIp, h5_info: { type: 'Wap' } }
  }

  if (cfg.mode === 'PARTNER') {
    const body: Record<string, unknown> = {
      sp_appid: cfg.spAppId,
      sp_mchid: cfg.credentials.mchId,
      sub_mchid: cfg.subMchId,
      ...common,
    }
    if (cfg.subAppId) body['sub_appid'] = cfg.subAppId
    if (tradeType === 'JSAPI') {
      // openid 归属 sub_appid 就用 sub_openid，归属服务商 appid 才用 sp_openid。
      body['payer'] = cfg.subAppId ? { sub_openid: input.openId } : { sp_openid: input.openId }
    }
    return body
  }

  const body: Record<string, unknown> = {
    appid: cfg.appId,
    mchid: cfg.credentials.mchId,
    ...common,
  }
  if (tradeType === 'JSAPI') body['payer'] = { openid: input.openId }
  return body
}

/** 查单路径（按商户订单号）。query 里的商户号两种模式不同。 */
export function queryOrderPath(cfg: WechatPayConfig, outTradeNo: string): string {
  const no = encodeURIComponent(outTradeNo)
  return cfg.mode === 'PARTNER'
    ? `/v3/pay/partner/transactions/out-trade-no/${no}?sp_mchid=${cfg.credentials.mchId}&sub_mchid=${cfg.subMchId}`
    : `/v3/pay/transactions/out-trade-no/${no}?mchid=${cfg.credentials.mchId}`
}

/** 关单路径。 */
export function closeOrderPath(cfg: WechatPayConfig, outTradeNo: string): string {
  const no = encodeURIComponent(outTradeNo)
  return cfg.mode === 'PARTNER'
    ? `/v3/pay/partner/transactions/out-trade-no/${no}/close`
    : `/v3/pay/transactions/out-trade-no/${no}/close`
}

/** 关单报文。 */
export function closeOrderBody(cfg: WechatPayConfig): Record<string, unknown> {
  return cfg.mode === 'PARTNER'
    ? { sp_mchid: cfg.credentials.mchId, sub_mchid: cfg.subMchId }
    : { mchid: cfg.credentials.mchId }
}

/**
 * 微信 `trade_state` → 框架的 {@link TradeState}。
 *
 * `USERPAYING`（等用户输密码）单独映射成 `PAYING`：它既不是成功也不是失败，
 * 混进 `NOTPAY` 的话，付款码支付会在用户正输密码的时候被判定为「没付」。
 */
export function mapTradeState(state: string): TradeState {
  switch (state) {
    case 'SUCCESS':
      return 'SUCCESS'
    case 'REFUND':
      return 'REFUND'
    case 'CLOSED':
      return 'CLOSED'
    case 'REVOKED':
      return 'REVOKED'
    case 'USERPAYING':
      return 'PAYING'
    case 'PAYERROR':
      return 'FAIL'
    case 'NOTPAY':
    default:
      return 'NOTPAY'
  }
}

/** 查单/下单应答归一化后的摘要。 */
export interface TransactionSummary {
  state: TradeState
  transactionId: string
  amountCents: number
  payer: PayerRef
  raw: Record<string, unknown>
}

/** 把查单应答归一化。直连的 `payer.openid` 与服务商的 `payer.sub_openid` 都认。 */
export function normalizeTransaction(json: Record<string, unknown>): TransactionSummary {
  const payer = json['payer'] as { openid?: string; sub_openid?: string } | undefined
  const amount = json['amount'] as { total?: number; payer_total?: number } | undefined
  const openId = payer?.openid ?? payer?.sub_openid
  return {
    state: mapTradeState(String(json['trade_state'] ?? '')),
    transactionId: String(json['transaction_id'] ?? ''),
    amountCents: Number(amount?.payer_total ?? amount?.total ?? 0),
    payer: openId ? { kind: 'openid', value: openId } : { kind: 'none' },
    raw: json,
  }
}

/** 退款报文。服务商模式下退款**只带 `sub_mchid`，不带 `sp_mchid`**（带了会被判为多余参数）。 */
export function buildRefundBody(
  cfg: WechatPayConfig,
  input: {
    outTradeNo: string
    outRefundNo: string
    totalCents: number
    refundCents: number
    reason?: string
    notifyUrl?: string
  },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    out_trade_no: input.outTradeNo,
    out_refund_no: input.outRefundNo,
    amount: { refund: input.refundCents, total: input.totalCents, currency: 'CNY' },
  }
  if (cfg.mode === 'PARTNER') body['sub_mchid'] = cfg.subMchId
  if (input.reason) body['reason'] = input.reason.slice(0, 80)
  if (input.notifyUrl) body['notify_url'] = input.notifyUrl
  return body
}

/** 退款查询路径（按商户退款单号）。 */
export function queryRefundPath(cfg: WechatPayConfig, outRefundNo: string): string {
  const no = encodeURIComponent(outRefundNo)
  return cfg.mode === 'PARTNER'
    ? `/v3/refund/domestic/refunds/${no}?sub_mchid=${cfg.subMchId}`
    : `/v3/refund/domestic/refunds/${no}`
}
