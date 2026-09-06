/**
 * `WechatPayClient`：直连商户 / 服务商两种模式的下单、查单、关单、退款、退款查询。
 *
 * 搬自 xiaodian `libs/wechatpay/src/wechatpay-client.ts`（724 行）的协议部分，
 * 三处改动：
 * 1. **去掉 axios 与 `@nestjs/common`**，网络走注入的 {@link HttpClient}；
 * 2. 报文/路径构造抽到 `platform-pay.ts`，本文件只剩「签名 → 发 → 验签 → 归一化」；
 * 3. 微信 4xx 的 `{code, message}` 统一包成 `PaymentError`（原实现是 axios 拦截器干的）。
 */
import {
  PAYMENT_ERROR,
  PaymentError,
  SignatureError,
  type RefundReq,
  type RefundRes,
  type RefundState,
} from '@taizan/payment-core'

import {
  buildRefundBody,
  buildTransactionBody,
  closeOrderBody,
  closeOrderPath,
  normalizeTransaction,
  queryOrderPath,
  queryRefundPath,
  transactionPath,
  type PlaceOrderInput,
  type TransactionSummary,
} from './platform-pay'
import { buildAuthorization, signJsapi, verifyResponseSignature, type JsapiPayParams } from './sign'
import { WECHATPAY_API_BASE, payAppId, type HttpClient, type WechatPayConfig } from './types'

/** 一次微信 API 调用的参数。 */
export interface WechatPayCall {
  method: 'GET' | 'POST'
  /** **含 query 的路径**（签名串用的就是它，query 少一个字符就验签失败）。 */
  path: string
  /** 请求体。对象会被 `JSON.stringify` 一次，同一串字节用于签名与发送。 */
  body?: Record<string, unknown> | string | Uint8Array
  /**
   * 签名串使用的正文，默认与 `body` 相同。
   *
   * **只有进件图片上传要用它**：微信规定那个接口签的是 `meta` JSON、发的是 multipart 全文。
   * 这是整个 V3 里唯一的例外。
   */
  signBody?: string
  /** 额外请求头（如进件的 `Wechatpay-Serial`）。 */
  extraHeaders?: Record<string, string>
  /** 是否验证应答签名，默认 `true`（没配任何平台公钥时自动跳过）。 */
  verifyResponse?: boolean
  /** 4xx 时返回 `null` 而不是抛（查单/查退款这类「查无此单不是错误」的接口用）。 */
  allowNotFound?: boolean
}

/**
 * 微信支付 API 的最小接口。
 *
 * `WechatPayProvider` 与 `profit-sharing` / `transfer` / `applyment` 都只依赖这个接口，
 * 所以测试里可以整体换成 {@link FakeWechatPayClient}，不需要拦截网络。
 */
export interface WechatPayApi {
  call<T = Record<string, unknown>>(cfg: WechatPayConfig, call: WechatPayCall): Promise<T | null>
  jsapi(
    cfg: WechatPayConfig,
    input: PlaceOrderInput,
  ): Promise<{ prepayId: string; payParams: JsapiPayParams }>
  native(cfg: WechatPayConfig, input: PlaceOrderInput): Promise<{ codeUrl: string }>
  h5(cfg: WechatPayConfig, input: PlaceOrderInput): Promise<{ h5Url: string }>
  queryByOutTradeNo(cfg: WechatPayConfig, outTradeNo: string): Promise<TransactionSummary | null>
  closeOrder(cfg: WechatPayConfig, outTradeNo: string): Promise<void>
  refund(cfg: WechatPayConfig, req: RefundReq): Promise<RefundRes>
  queryRefund(cfg: WechatPayConfig, outRefundNo: string): Promise<RefundRes | null>
}

/** {@link WechatPayClient} 构造参数。 */
export interface WechatPayClientOptions {
  http: HttpClient
  /** API 网关，默认 {@link WECHATPAY_API_BASE}（测试里可以指向本地桩）。 */
  baseUrl?: string
  /** `User-Agent`。微信要求带，缺了偶发被网关拒。 */
  userAgent?: string
}

/** 微信把退款状态叫 `status`，取值与我们的 {@link RefundState} 同名，这里只做一次收窄。 */
function toRefundState(status: string): RefundState {
  switch (status) {
    case 'SUCCESS':
      return 'SUCCESS'
    case 'CLOSED':
      return 'CLOSED'
    case 'ABNORMAL':
      return 'ABNORMAL'
    default:
      return 'PROCESSING'
  }
}

export class WechatPayClient implements WechatPayApi {
  private readonly http: HttpClient
  private readonly baseUrl: string
  private readonly userAgent: string

  constructor(opts: WechatPayClientOptions) {
    this.http = opts.http
    this.baseUrl = opts.baseUrl ?? WECHATPAY_API_BASE
    this.userAgent = opts.userAgent ?? 'taizan-saas/@taizan/wechatpay'
  }

  /**
   * 发一次已签名的微信 API 请求，并（在可能时）验证应答签名。
   *
   * @returns 应答 JSON；`allowNotFound` 且遇到 4xx 时返回 `null`；204 空响应返回 `null`
   * @throws {PaymentError} 微信返回 4xx/5xx（message 带上微信的 `code`/`message`/`request-id`）
   * @throws {SignatureError} 应答验签失败——**这时不能信任响应内容**
   */
  async call<T = Record<string, unknown>>(
    cfg: WechatPayConfig,
    call: WechatPayCall,
  ): Promise<T | null> {
    const sendBody: string | Uint8Array | undefined =
      call.body === undefined || typeof call.body === 'string' || call.body instanceof Uint8Array
        ? call.body
        : JSON.stringify(call.body)
    const signText =
      call.signBody ?? (typeof sendBody === 'string' ? sendBody : sendBody === undefined ? '' : '')
    const authorization = buildAuthorization({
      mchId: cfg.credentials.mchId,
      serialNo: cfg.credentials.serialNo,
      privateKeyPem: cfg.credentials.privateKeyPem,
      method: call.method,
      urlPath: call.path,
      body: signText,
    })

    const headers: Record<string, string> = {
      Authorization: authorization,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      ...(call.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      // extraHeaders 放最后：进件图片上传要用它覆盖掉上面那个 Content-Type。
      ...(call.extraHeaders ?? {}),
    }

    const res = await this.http.request({
      method: call.method,
      url: `${this.baseUrl}${call.path}`,
      headers,
      ...(call.method === 'POST' && sendBody !== undefined ? { body: sendBody } : {}),
    })

    if (res.status >= 400) {
      if (call.allowNotFound && res.status < 500) return null
      throw this.upstreamError(res.status, res.body, res.headers)
    }

    // 应答验签：只有配了平台公钥/证书、且响应带了签名头时才做。
    // 没配就跳过而不是抛——过渡期里有的租户还没配公钥，抛的话连下单都做不了。
    if (call.verifyResponse !== false && res.headers['wechatpay-signature']) {
      const verified = verifyResponseSignature({
        credentials: cfg.credentials,
        serial: res.headers['wechatpay-serial'] ?? '',
        timestamp: res.headers['wechatpay-timestamp'] ?? '',
        nonce: res.headers['wechatpay-nonce'] ?? '',
        body: res.body,
        signature: res.headers['wechatpay-signature'],
      })
      if (verified.pem && !verified.ok) {
        throw new SignatureError('[@taizan/wechatpay] 微信应答验签失败，响应内容不可信', {
          path: call.path,
        })
      }
    }

    if (!res.body) return null
    try {
      return JSON.parse(res.body) as T
    } catch {
      throw PaymentError.of(
        PAYMENT_ERROR.UPSTREAM_ERROR,
        `[@taizan/wechatpay] 微信应答不是合法 JSON（${call.path}）`,
      )
    }
  }

  /**
   * 把微信的错误响应包成 `PaymentError`。
   *
   * 微信 4xx 的 body 是 `{code, message, detail}`（如 `NOT_ENOUGH` 余额不足、
   * `NO_AUTH` 无退款权限，都是 403）。**不带上 `code` 的话，日志里只剩一句
   * 「Request failed with status code 403」，什么也查不出来**——xiaodian 那边为此专门
   * 写了一个 axios 拦截器，这里内建。
   */
  private upstreamError(
    status: number,
    body: string,
    headers: Record<string, string>,
  ): PaymentError {
    let code = ''
    let message = ''
    let detail: unknown
    try {
      const json = JSON.parse(body) as { code?: string; message?: string; detail?: unknown }
      code = json.code ?? ''
      message = json.message ?? ''
      detail = json.detail
    } catch {
      message = body.slice(0, 200)
    }
    // request-id 是微信排障的唯一凭据：有它说明请求到了业务层（签名证书都没问题），
    // 没它多半是路径写错了。
    const requestId = headers['request-id'] ?? ''
    return PaymentError.of(
      PAYMENT_ERROR.UPSTREAM_ERROR,
      `微信支付API[${status}] ${code} ${message}`.trim(),
      { status, code, requestId, detail },
    )
  }

  private async placeOrder<T>(
    cfg: WechatPayConfig,
    input: PlaceOrderInput,
    tradeType: 'JSAPI' | 'NATIVE' | 'H5',
  ): Promise<T> {
    const path = transactionPath(cfg, tradeType)
    const body = buildTransactionBody(cfg, input, tradeType)
    const res = await this.call<T>(cfg, { method: 'POST', path, body })
    if (!res) {
      throw PaymentError.of(PAYMENT_ERROR.UPSTREAM_ERROR, '[@taizan/wechatpay] 下单应答为空')
    }
    return res
  }

  /** JSAPI/小程序下单，返回 `prepay_id` 与**已二次签名**的调起参数。 */
  async jsapi(
    cfg: WechatPayConfig,
    input: PlaceOrderInput,
  ): Promise<{ prepayId: string; payParams: JsapiPayParams }> {
    const res = await this.placeOrder<{ prepay_id?: string }>(cfg, input, 'JSAPI')
    const prepayId = res.prepay_id
    if (!prepayId) {
      throw PaymentError.of(
        PAYMENT_ERROR.UPSTREAM_ERROR,
        '[@taizan/wechatpay] 下单应答缺 prepay_id',
      )
    }
    return {
      prepayId,
      payParams: signJsapi({
        // 二次签名的 appId 必须与下单报文里的一致，服务商模式即 sub_appid。
        appId: payAppId(cfg),
        prepayId,
        privateKeyPem: cfg.credentials.privateKeyPem,
      }),
    }
  }

  /** Native 扫码下单，返回 `code_url` 供生成二维码。 */
  async native(cfg: WechatPayConfig, input: PlaceOrderInput): Promise<{ codeUrl: string }> {
    const res = await this.placeOrder<{ code_url?: string }>(cfg, input, 'NATIVE')
    return { codeUrl: String(res.code_url ?? '') }
  }

  /** H5（MWEB，微信外浏览器）下单，返回 `h5_url`。 */
  async h5(cfg: WechatPayConfig, input: PlaceOrderInput): Promise<{ h5Url: string }> {
    const res = await this.placeOrder<{ h5_url?: string }>(cfg, input, 'H5')
    return { h5Url: String(res.h5_url ?? '') }
  }

  /**
   * 按商户订单号查单。**支付后的兜底确认，不依赖异步通知**——
   * 回调可能丢、可能延迟，只靠回调的系统一定会漏单。
   *
   * 查无此单返回 `null`（微信回 4xx `NOTFOUND`），不抛。
   */
  async queryByOutTradeNo(
    cfg: WechatPayConfig,
    outTradeNo: string,
  ): Promise<TransactionSummary | null> {
    const json = await this.call<Record<string, unknown>>(cfg, {
      method: 'GET',
      path: queryOrderPath(cfg, outTradeNo),
      allowNotFound: true,
    })
    return json ? normalizeTransaction(json) : null
  }

  /** 关单。已支付的单关不掉（微信回 `ORDERPAID`），这里照常抛。 */
  async closeOrder(cfg: WechatPayConfig, outTradeNo: string): Promise<void> {
    await this.call(cfg, {
      method: 'POST',
      path: closeOrderPath(cfg, outTradeNo),
      body: closeOrderBody(cfg),
    })
  }

  /** 申请退款。 */
  async refund(cfg: WechatPayConfig, req: RefundReq): Promise<RefundRes> {
    const body = buildRefundBody(cfg, {
      outTradeNo: req.outTradeNo,
      outRefundNo: req.outRefundNo,
      totalCents: req.totalCents,
      refundCents: req.refundCents,
      ...(req.reason ? { reason: req.reason } : {}),
      ...(req.notifyUrl ? { notifyUrl: req.notifyUrl } : {}),
    })
    const res = await this.call<{
      refund_id?: string
      status?: string
      amount?: { refund?: number }
    }>(cfg, { method: 'POST', path: '/v3/refund/domestic/refunds', body })
    if (!res) {
      throw PaymentError.of(PAYMENT_ERROR.UPSTREAM_ERROR, '[@taizan/wechatpay] 退款应答为空')
    }
    return {
      refundId: String(res.refund_id ?? ''),
      status: toRefundState(String(res.status ?? '')),
      refundCents: Number(res.amount?.refund ?? req.refundCents),
      raw: res,
    }
  }

  /** 按商户退款单号查退款。查无此单返回 `null`。 */
  async queryRefund(cfg: WechatPayConfig, outRefundNo: string): Promise<RefundRes | null> {
    const res = await this.call<{
      refund_id?: string
      status?: string
      amount?: { refund?: number }
    }>(cfg, { method: 'GET', path: queryRefundPath(cfg, outRefundNo), allowNotFound: true })
    if (!res) return null
    return {
      refundId: String(res.refund_id ?? ''),
      status: toRefundState(String(res.status ?? '')),
      refundCents: Number(res.amount?.refund ?? 0),
      raw: res,
    }
  }
}
