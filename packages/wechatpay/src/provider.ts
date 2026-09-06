/**
 * `WechatPayProvider`：把本包的签名/下单/回调拼成蓝图 §4.12 的 `PaymentProvider`。
 *
 * 这是**唯一**被领域代码看见的入口：套餐订单只调 `createOrder` / 拿 `CallbackEvent`，
 * 不知道 `sp_mchid`、`prepay_id`、`AEAD_AES_256_GCM` 这些词。
 */
import {
  PAYMENT_ERROR,
  PaymentError,
  type CallbackEvent,
  type CreateOrderReq,
  type CreateOrderRes,
  type PayChannel,
  type PaymentProvider,
  type ProviderConfig,
  type QueryOrderRes,
  type RawCallback,
  type RefundEvent,
  type RefundReq,
  type RefundRes,
} from '@taizan/payment-core'

import {
  parseWechatPayCallback,
  parseWechatPayRefundCallback,
  type ParseCallbackOptions,
} from './callback'
import type { WechatPayApi } from './client'
import type { PlaceOrderInput } from './platform-pay'
import { narrowWechatPayConfig, type TradeType } from './types'

/** {@link WechatPayProvider} 构造参数。 */
export interface WechatPayProviderOptions {
  api: WechatPayApi
  /**
   * 回调解析选项（如关掉时间窗检查、注入平台证书兜底）。
   *
   * 放在构造参数而不是 `parseCallback` 的入参里，是因为蓝图定死了 `parseCallback(raw, cfg)`
   * 两个参数——这些属于装配期决定的东西，不是每次回调都变的东西。
   */
  callbackOptions?: ParseCallbackOptions
}

/**
 * 从 `CreateOrderReq.extra.tradeType` 决定支付方式；没给就按付款人推断：
 * 有 openid → JSAPI，没有 → NATIVE。
 *
 * 推断而不是必填，是因为绝大多数调用点只有一种可能；而**推错的代价是下单直接失败**
 * （不是静默错账），所以这里的默认值是安全的。
 */
function resolveTradeType(req: CreateOrderReq): TradeType {
  const explicit = req.extra?.['tradeType']
  if (explicit === 'JSAPI' || explicit === 'NATIVE' || explicit === 'H5') return explicit
  return req.payer.kind === 'openid' ? 'JSAPI' : 'NATIVE'
}

function toPlaceOrderInput(req: CreateOrderReq): PlaceOrderInput {
  const input: PlaceOrderInput = {
    outTradeNo: req.outTradeNo,
    amountCents: req.amountCents,
    description: req.description,
    notifyUrl: req.notifyUrl,
  }
  if (req.payer.kind === 'openid' && req.payer.value) input.openId = req.payer.value
  const extra = req.extra ?? {}
  if (typeof extra['payerClientIp'] === 'string') input.payerClientIp = extra['payerClientIp']
  if (typeof extra['attach'] === 'string') input.attach = extra['attach']
  if (typeof extra['timeExpire'] === 'string') input.timeExpire = extra['timeExpire']
  if (extra['profitSharing'] === true) input.profitSharing = true
  return input
}

export class WechatPayProvider implements PaymentProvider {
  readonly channel: PayChannel = 'WECHAT'

  private readonly api: WechatPayApi
  private readonly callbackOptions: ParseCallbackOptions

  constructor(opts: WechatPayProviderOptions) {
    this.api = opts.api
    this.callbackOptions = opts.callbackOptions ?? {}
  }

  async createOrder(req: CreateOrderReq, cfg: ProviderConfig): Promise<CreateOrderRes> {
    const wxCfg = narrowWechatPayConfig(cfg)
    const input = toPlaceOrderInput(req)
    const tradeType = resolveTradeType(req)

    if (tradeType === 'JSAPI') {
      const { prepayId, payParams } = await this.api.jsapi(wxCfg, input)
      // payParams 是已经二次签名好的整包，**上层原样下发给前端，不许改任何一个字段**。
      return { payParams: { ...payParams }, prepayRef: prepayId }
    }
    if (tradeType === 'NATIVE') {
      const { codeUrl } = await this.api.native(wxCfg, input)
      return { payParams: { codeUrl }, prepayRef: codeUrl }
    }
    const { h5Url } = await this.api.h5(wxCfg, input)
    return { payParams: { h5Url }, prepayRef: h5Url }
  }

  async parseCallback(raw: RawCallback, cfg: ProviderConfig): Promise<CallbackEvent> {
    return parseWechatPayCallback(raw, narrowWechatPayConfig(cfg), this.callbackOptions)
  }

  async queryOrder(outTradeNo: string, cfg: ProviderConfig): Promise<QueryOrderRes> {
    const wxCfg = narrowWechatPayConfig(cfg)
    const summary = await this.api.queryByOutTradeNo(wxCfg, outTradeNo)
    // 查无此单 = 没付过。返回 NOTPAY 而不是抛，因为「还没付」是查单最常见的正常结果。
    if (!summary) return { state: 'NOTPAY' }
    return {
      state: summary.state,
      transactionId: summary.transactionId,
      amountCents: summary.amountCents,
      payer: summary.payer,
      raw: summary.raw,
    }
  }

  async refund(req: RefundReq, cfg: ProviderConfig): Promise<RefundRes> {
    const wxCfg = narrowWechatPayConfig(cfg)
    if (req.refundCents <= 0 || req.refundCents > req.totalCents) {
      // 在调微信之前拦住：微信回的是 `PARAM_ERROR`，看不出是金额关系不对。
      throw PaymentError.of(
        PAYMENT_ERROR.BAD_REQUEST,
        `[@taizan/wechatpay] 退款金额 ${req.refundCents} 分不合法（原单 ${req.totalCents} 分）`,
      )
    }
    return this.api.refund(wxCfg, req)
  }

  async parseRefundCallback(raw: RawCallback, cfg: ProviderConfig): Promise<RefundEvent> {
    return parseWechatPayRefundCallback(raw, narrowWechatPayConfig(cfg), this.callbackOptions)
  }
}
