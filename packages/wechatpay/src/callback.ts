/**
 * 微信支付回调：验签 → AES-256-GCM 解密 → 归一化成 `@taizan/payment-core` 的事件。
 *
 * 搬自 xiaodian `libs/wechatpay/src/wechatpay-callback.ts`（双模式验签 + 直连/服务商
 * `openid` / `sub_openid` 兼容）与 knowledge `v3-sign.ts` 的 `decryptResource`，
 * 归一化输出换成蓝图 §4.12 的 `CallbackEvent` / `RefundEvent`。
 *
 * ## 三道关卡，一道都不能省
 *
 * 1. **验签**：证明报文由微信私钥签发。只解密不验签挡不住伪造——APIv3 密钥一旦泄露，
 *    任何人都能构造出能解开的报文。
 * 2. **时间窗**：挡重放。原样重发一份真实的旧回调，签名是对的。
 * 3. **解密**：GCM 的认证标签在 `final()` 时校验，篡改过的密文解不出来。
 *
 * 幂等（按 `transactionId`）是第四道，但那属于 `@taizan/nest-payment` 的统一回调控制器。
 */
import {
  CallbackParseError,
  SignatureError,
  type CallbackEvent,
  type PayerRef,
  type RawCallback,
  type RefundEvent,
} from '@taizan/payment-core'
import { createDecipheriv } from 'node:crypto'

import { isTimestampFresh, verifyResponseSignature } from './sign'
import type { WechatPayConfig } from './types'

/** 回调报文的外层结构（未解密）。 */
export interface WechatNotifyEnvelope {
  id: string
  create_time: string
  event_type: string
  resource_type: string
  summary?: string
  resource: {
    algorithm: string
    ciphertext: string
    associated_data?: string
    nonce: string
    original_type?: string
  }
}

/** 解析回调时的可选项。 */
export interface ParseCallbackOptions {
  /** 自动下载的平台证书兜底（公钥/平台证书混签的过渡期用）。 */
  extraCerts?: readonly { serialNo: string; certPem: string }[]
  /** 关掉时间窗检查。**只在回放存档报文的测试里关**，生产关掉等于放弃重放防护。 */
  skipTimestampCheck?: boolean
  /** 注入当前时间，便于测试。 */
  now?: number
}

/** 大小写不敏感地取一个请求头（微信发的是 `Wechatpay-Signature`，网关可能改大小写）。 */
export function pickHeader(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v
  }
  return ''
}

/**
 * 用 APIv3 密钥解密回调里的 `resource`（AES-256-GCM）。
 *
 * 认证标签校验在 `final()` 时触发，**篡改过的密文会抛而不是返回垃圾数据**。
 */
export function decryptResource(
  apiV3Key: string,
  resource: { ciphertext: string; nonce: string; associated_data?: string },
): string {
  const key = Buffer.from(apiV3Key, 'utf8')
  if (key.length !== 32) {
    // 提前挡住：apiV3Key 配成 31/33 字节时 createDecipheriv 抛的是
    // 「Invalid key length」，看不出是哪个密钥配错了。
    throw new CallbackParseError(
      `[@taizan/wechatpay] apiV3Key 必须正好 32 字节，当前 ${key.length} 字节`,
    )
  }
  const cipherBuf = Buffer.from(resource.ciphertext, 'base64')
  const authTag = cipherBuf.subarray(cipherBuf.length - 16)
  const data = cipherBuf.subarray(0, cipherBuf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'))
  decipher.setAuthTag(authTag)
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'))
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/**
 * 验签 + 解密，返回外层信封与解密后的明文对象。
 *
 * @throws {SignatureError} 序列号对不上、签名不匹配、时间戳超窗
 * @throws {CallbackParseError} JSON 坏、算法不支持、解密失败
 */
export function verifyAndDecrypt(
  raw: RawCallback,
  cfg: WechatPayConfig,
  opts: ParseCallbackOptions = {},
): { envelope: WechatNotifyEnvelope; resource: Record<string, unknown> } {
  const timestamp = pickHeader(raw.headers, 'Wechatpay-Timestamp')
  const nonce = pickHeader(raw.headers, 'Wechatpay-Nonce')
  const signature = pickHeader(raw.headers, 'Wechatpay-Signature')
  const serial = pickHeader(raw.headers, 'Wechatpay-Serial')
  if (!timestamp || !nonce || !signature || !serial) {
    throw new SignatureError('[@taizan/wechatpay] 回调缺少 Wechatpay-* 验签头')
  }
  if (!opts.skipTimestampCheck && !isTimestampFresh(timestamp, opts.now ?? Date.now())) {
    throw new SignatureError('[@taizan/wechatpay] 回调时间戳超出容忍窗口，按重放处理', {
      timestamp,
    })
  }

  const verified = verifyResponseSignature({
    credentials: cfg.credentials,
    serial,
    timestamp,
    nonce,
    body: raw.body,
    signature,
    ...(opts.extraCerts ? { extraCerts: opts.extraCerts } : {}),
  })
  if (!verified.pem) {
    throw new SignatureError(
      '[@taizan/wechatpay] 回调 Wechatpay-Serial 与已配置的微信支付公钥ID/平台证书序列号均不匹配',
      { serial },
    )
  }
  if (!verified.ok) {
    throw new SignatureError('[@taizan/wechatpay] 回调验签失败', { serial })
  }

  let envelope: WechatNotifyEnvelope
  try {
    envelope = JSON.parse(raw.body) as WechatNotifyEnvelope
  } catch {
    throw new CallbackParseError('[@taizan/wechatpay] 回调报文不是合法 JSON')
  }
  if (envelope?.resource?.algorithm !== 'AEAD_AES_256_GCM') {
    throw new CallbackParseError(
      `[@taizan/wechatpay] 不支持的 resource.algorithm：${String(envelope?.resource?.algorithm)}`,
    )
  }

  let plaintext: string
  try {
    plaintext = decryptResource(cfg.credentials.apiV3Key, envelope.resource)
  } catch (e) {
    if (e instanceof CallbackParseError) throw e
    throw new CallbackParseError(
      '[@taizan/wechatpay] resource 解密失败（apiV3Key 不对，或报文被篡改）',
    )
  }

  let resource: unknown
  try {
    resource = JSON.parse(plaintext)
  } catch {
    throw new CallbackParseError('[@taizan/wechatpay] resource 解密后不是合法 JSON')
  }
  if (typeof resource !== 'object' || resource === null) {
    throw new CallbackParseError('[@taizan/wechatpay] resource 解密后不是对象')
  }
  return { envelope, resource: resource as Record<string, unknown> }
}

/**
 * 从回调明文里取付款人。
 *
 * 直连回调是 `payer.openid`，服务商回调是 `payer.sub_openid`——两边字段名不同，
 * 只读其中一个的表现是「服务商模式下所有回调都查不到用户」。
 */
export function extractPayer(resource: Record<string, unknown>): PayerRef {
  const payer = resource['payer'] as { openid?: string; sub_openid?: string } | undefined
  const value = payer?.openid ?? payer?.sub_openid
  return value ? { kind: 'openid', value } : { kind: 'none' }
}

/**
 * 支付回调 → 归一化的 {@link CallbackEvent}。
 *
 * `trade_state` 只有 `SUCCESS` 算 `PAY_SUCCESS`，其余（`CLOSED`/`PAYERROR`/`REVOKED`…）
 * 一律 `PAY_FAIL`——**不要把 `NOTPAY` 之类当成「还在处理，等下一次回调」**：
 * 微信不会为一笔失败的单反复回调，等下去就是订单永远悬着。
 */
export function parseWechatPayCallback(
  raw: RawCallback,
  cfg: WechatPayConfig,
  opts: ParseCallbackOptions = {},
): CallbackEvent {
  const { resource } = verifyAndDecrypt(raw, cfg, opts)
  const outTradeNo = String(resource['out_trade_no'] ?? '')
  if (!outTradeNo) {
    throw new CallbackParseError('[@taizan/wechatpay] 支付回调缺少 out_trade_no')
  }
  const tradeState = String(resource['trade_state'] ?? '')
  const successTime = resource['success_time']
  const amount = resource['amount'] as { total?: number; payer_total?: number } | undefined
  return {
    kind: tradeState === 'SUCCESS' ? 'PAY_SUCCESS' : 'PAY_FAIL',
    channel: 'WECHAT',
    outTradeNo,
    transactionId: String(resource['transaction_id'] ?? ''),
    // payer_total 是用户实付（扣掉优惠），total 是订单原价。
    // 对账要用实付，否则用了微信立减金的订单会永远对不平。
    amountCents: Number(amount?.payer_total ?? amount?.total ?? 0),
    paidAt: typeof successTime === 'string' ? new Date(successTime) : new Date(),
    payer: extractPayer(resource),
    raw: resource,
  }
}

/**
 * 退款回调 → 归一化的 {@link RefundEvent}。
 *
 * 微信的 `refund_status`：`SUCCESS` / `CLOSED` / `ABNORMAL`。
 * `ABNORMAL` 不是「失败了别管」——它意味着退款卡在微信侧需要人工处理，
 * 上层应该报警而不是静默重试。
 */
export function parseWechatPayRefundCallback(
  raw: RawCallback,
  cfg: WechatPayConfig,
  opts: ParseCallbackOptions = {},
): RefundEvent {
  const { resource } = verifyAndDecrypt(raw, cfg, opts)
  const outRefundNo = String(resource['out_refund_no'] ?? '')
  if (!outRefundNo) {
    throw new CallbackParseError('[@taizan/wechatpay] 退款回调缺少 out_refund_no')
  }
  const status = String(resource['refund_status'] ?? '')
  const successTime = resource['success_time']
  const amount = resource['amount'] as { refund?: number; total?: number } | undefined
  return {
    kind:
      status === 'SUCCESS'
        ? 'REFUND_SUCCESS'
        : status === 'CLOSED'
          ? 'REFUND_CLOSED'
          : 'REFUND_FAIL',
    channel: 'WECHAT',
    outTradeNo: String(resource['out_trade_no'] ?? ''),
    outRefundNo,
    refundId: String(resource['refund_id'] ?? ''),
    refundCents: Number(amount?.refund ?? 0),
    totalCents: Number(amount?.total ?? 0),
    successAt: typeof successTime === 'string' ? new Date(successTime) : null,
    raw: resource,
  }
}
