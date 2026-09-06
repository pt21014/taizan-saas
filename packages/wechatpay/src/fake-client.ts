/**
 * `FakeWechatPayClient`：不联网的 {@link WechatPayApi} 实现。
 *
 * 搬自 xiaodian `libs/wechatpay/src/fake-wechatpay-client.ts`（195 行），
 * 去掉 `@nestjs/common` 的 `@Injectable()`，接口对齐本包的 `WechatPayApi`。
 *
 * ## 它和 `FakeProvider` 的分工
 *
 * - `@taizan/payment-core` 的 `FakeProvider`：整个渠道都是假的，**e2e 用**——
 *   连微信的报文形状都不出现。
 * - `FakeWechatPayClient`：只有网络那一层是假的，**单测用**——
 *   `WechatPayProvider` 的报文构造、二次签名、归一化仍然是真代码在跑。
 *
 * 需要断言「发出去的报文长什么样」时用后者：`lastCalls` 记下了每一次调用。
 */
import type { RefundReq, RefundRes } from '@taizan/payment-core'

import type { WechatPayApi, WechatPayCall } from './client'
import type { PlaceOrderInput, TransactionSummary } from './platform-pay'
import { signJsapi, type JsapiPayParams } from './sign'
import { payAppId, type WechatPayConfig } from './types'

/** 记录下来的一次调用。 */
export interface RecordedCall {
  kind: string
  cfg: WechatPayConfig
  payload: unknown
}

export class FakeWechatPayClient implements WechatPayApi {
  /** 每一次调用的流水，断言报文用。 */
  readonly calls: RecordedCall[] = []

  prepayCounter = 0
  nativeCounter = 0
  h5Counter = 0
  refundCounter = 0

  /** `call()` 的预置应答：键是 `` `${method} ${path}` ``，命中就返回对应值。 */
  readonly responses = new Map<string, unknown>()

  /** {@link queryByOutTradeNo} 返回的结果；`null` 表示查无此单。 */
  queryResult: TransactionSummary | null = null

  private record(kind: string, cfg: WechatPayConfig, payload: unknown): void {
    this.calls.push({ kind, cfg, payload })
  }

  /** 最近一次某种调用的载荷。 */
  lastCall(kind: string): RecordedCall | undefined {
    return [...this.calls].reverse().find((c) => c.kind === kind)
  }

  reset(): void {
    this.calls.length = 0
    this.responses.clear()
    this.queryResult = null
    this.prepayCounter = 0
    this.nativeCounter = 0
    this.h5Counter = 0
    this.refundCounter = 0
  }

  async call<T = Record<string, unknown>>(
    cfg: WechatPayConfig,
    call: WechatPayCall,
  ): Promise<T | null> {
    this.record('call', cfg, call)
    const key = `${call.method} ${call.path}`
    return (this.responses.has(key) ? (this.responses.get(key) as T) : ({} as T)) ?? null
  }

  async jsapi(
    cfg: WechatPayConfig,
    input: PlaceOrderInput,
  ): Promise<{ prepayId: string; payParams: JsapiPayParams }> {
    this.record('jsapi', cfg, input)
    if (!input.openId) throw new Error('FakeWechatPayClient: JSAPI 下单缺少 openId')
    this.prepayCounter += 1
    const prepayId = `wx-fake-${this.prepayCounter}-${input.outTradeNo}`
    // 二次签名走真代码：私钥是测试造的，签出来的值能被对应公钥验过。
    return {
      prepayId,
      payParams: signJsapi({
        appId: payAppId(cfg),
        prepayId,
        privateKeyPem: cfg.credentials.privateKeyPem,
      }),
    }
  }

  async native(cfg: WechatPayConfig, input: PlaceOrderInput): Promise<{ codeUrl: string }> {
    this.record('native', cfg, input)
    this.nativeCounter += 1
    return { codeUrl: `weixin://wxpay/bizpayurl?pr=fake${this.nativeCounter}` }
  }

  async h5(cfg: WechatPayConfig, input: PlaceOrderInput): Promise<{ h5Url: string }> {
    this.record('h5', cfg, input)
    this.h5Counter += 1
    return {
      h5Url: `https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=fake${this.h5Counter}`,
    }
  }

  async queryByOutTradeNo(
    cfg: WechatPayConfig,
    outTradeNo: string,
  ): Promise<TransactionSummary | null> {
    this.record('queryByOutTradeNo', cfg, { outTradeNo })
    return this.queryResult
  }

  async closeOrder(cfg: WechatPayConfig, outTradeNo: string): Promise<void> {
    this.record('closeOrder', cfg, { outTradeNo })
  }

  async refund(cfg: WechatPayConfig, req: RefundReq): Promise<RefundRes> {
    this.record('refund', cfg, req)
    this.refundCounter += 1
    return {
      refundId: `wx-refund-${this.refundCounter}-${req.outRefundNo}`,
      status: 'SUCCESS',
      refundCents: req.refundCents,
    }
  }

  async queryRefund(cfg: WechatPayConfig, outRefundNo: string): Promise<RefundRes | null> {
    this.record('queryRefund', cfg, { outRefundNo })
    return { refundId: `wx-refund-q-${outRefundNo}`, status: 'SUCCESS', refundCents: 0 }
  }
}
