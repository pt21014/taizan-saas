/**
 * 微信支付 V3 的签名与验签。纯函数，只用 `node:crypto`。
 *
 * 两个方向别搞混（搬自 knowledge `payment/wechat/v3-sign.ts` 的开篇注释）：
 * - **我们发出去的请求**：用商户私钥签，微信用我们上传的商户证书验；
 * - **微信回给我们的应答与回调**：用微信支付公钥（或平台证书）验，证明确实是微信发的。
 *
 * 本文件是 xiaodian `libs/wechatpay/src/sign.ts` 与 knowledge `v3-sign.ts` 的合并：
 * 前者贡献「平台证书 / 微信支付公钥双模式选 PEM」（`selectVerifyPem`），
 * 后者贡献「按官方文档逐字节比对的待签名串构造」（`buildSignMessage`）与时间戳新鲜度检查。
 */
import {
  X509Certificate,
  createPublicKey,
  createSign,
  createVerify,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

import type { WechatPayCredentials } from './types'

/** 生成随机串（hex 大写）。微信要求 ≤32 位，16 字节 hex 正好 32。 */
export function generateNonce(byteLen = 16): string {
  return randomBytes(byteLen).toString('hex').toUpperCase()
}

/** 当前秒级时间戳字符串。 */
export function currentTimestamp(now: number = Date.now()): string {
  return Math.floor(now / 1000).toString()
}

/**
 * 构造待签名串。**字段顺序与末尾换行都是协议规定的，一个字节都不能差。**
 *
 * 官方文档（[V3 签名生成](https://pay.weixin.qq.com/wiki/doc/apiv3/wechatpay/wechatpay4_0.shtml)）
 * 给的样例就是 GET `/v3/certificates` 那一组，`sign.spec.ts` 里对它做了逐字节断言。
 */
export function buildSignMessage(input: {
  method: string
  /** **含 query 的完整路径**，如 `/v3/pay/partner/transactions/jsapi`。少带 query 会验签失败。 */
  urlPath: string
  timestamp: string
  nonce: string
  /** GET 请求为空串，但它后面那个换行不能省。 */
  body: string
}): string {
  return `${input.method}\n${input.urlPath}\n${input.timestamp}\n${input.nonce}\n${input.body}\n`
}

/** 用商户私钥做 RSA-SHA256 签名，输出 base64。 */
export function rsaSha256Sign(message: string, privateKeyPem: string): string {
  const signer = createSign('RSA-SHA256')
  signer.update(message, 'utf8')
  signer.end()
  return signer.sign(privateKeyPem, 'base64')
}

/**
 * 验证 RSA-SHA256 签名。
 *
 * 同时接受 **PEM 编码的 X.509 证书**（微信平台证书）与 **PEM 编码的公钥**（微信支付公钥）——
 * 两种模式下微信给的东西不一样，但验签算法完全相同，所以这里按内容自动判别，
 * 免得调用方还要先判断自己拿的是证书还是公钥。
 *
 * 签名不是合法 base64 之类的脏输入返回 `false` 而不是抛异常：验签失败就是验签失败，
 * 让它抛会逼着每个调用点都包一层 try。
 */
export function rsaSha256Verify(
  message: string,
  signatureBase64: string,
  certOrPublicKeyPem: string,
): boolean {
  try {
    const verifier = createVerify('RSA-SHA256')
    verifier.update(message, 'utf8')
    verifier.end()
    return verifier.verify(toPublicKey(certOrPublicKeyPem), signatureBase64, 'base64')
  } catch {
    return false
  }
}

/** PEM 证书或 PEM 公钥 → KeyObject。 */
export function toPublicKey(certOrPublicKeyPem: string): KeyObject {
  if (certOrPublicKeyPem.includes('BEGIN CERTIFICATE')) {
    return new X509Certificate(certOrPublicKeyPem).publicKey
  }
  return createPublicKey(certOrPublicKeyPem)
}

/**
 * 生成 `Authorization` 头。
 *
 * @param input.nonce - 显式指定随机串（只有测试才该传；生产必须让它随机，否则可被重放）
 * @param input.now - 显式指定时间（同上）
 */
export function buildAuthorization(input: {
  mchId: string
  serialNo: string
  privateKeyPem: string
  method: string
  urlPath: string
  body: string
  nonce?: string
  now?: Date
}): string {
  const timestamp = currentTimestamp(input.now?.getTime() ?? Date.now())
  const nonce = input.nonce ?? generateNonce()
  const message = buildSignMessage({
    method: input.method.toUpperCase(),
    urlPath: input.urlPath,
    timestamp,
    nonce,
    body: input.body,
  })
  const signature = rsaSha256Sign(message, input.privateKeyPem)
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${input.mchId}",` +
    `nonce_str="${nonce}",signature="${signature}",` +
    `timestamp="${timestamp}",serial_no="${input.serialNo}"`
  )
}

/**
 * 按响应/回调头里的 `Wechatpay-Serial` 选出验签用的 PEM（搬自 xiaodian `sign.ts`）：
 * - 等于公钥 ID（`PUB_KEY_ID_...`）→ 用微信支付公钥（新版）
 * - 等于平台证书序列号 → 用平台证书（旧版，兼容）
 * - 都不匹配 → 返回 `null`，调用方必须当成验签失败
 *
 * `trim()` 是兜底：env / header 里可能混进不可见空白，导致序列号「看着一样却不相等」，
 * 那种问题肉眼看日志根本看不出来。
 *
 * 文档：https://pay.weixin.qq.com/doc/v3/partner/4012925323
 */
export function selectVerifyPem(opts: {
  serial: string
  publicKeyId?: string | null
  publicKeyPem?: string | null
  platformSerialNo?: string | null
  platformCertPem?: string | null
  /** 自动下载的平台证书（serial → PEM）兜底，用于公钥/平台证书混签的过渡期。 */
  extraCerts?: readonly { serialNo: string; certPem: string }[]
}): string | null {
  const serial = (opts.serial ?? '').trim()
  const pubKeyId = (opts.publicKeyId ?? '').trim()
  const platSerial = (opts.platformSerialNo ?? '').trim()
  if (pubKeyId && opts.publicKeyPem && serial === pubKeyId) return opts.publicKeyPem
  if (platSerial && opts.platformCertPem && serial === platSerial) return opts.platformCertPem
  const extra = opts.extraCerts?.find((c) => c.serialNo.trim() === serial)
  return extra ? extra.certPem : null
}

/**
 * 验证微信应答/回调的签名。
 *
 * 待验签串是 `时间戳\n随机串\n报文主体\n`，用微信支付公钥（或平台证书）验
 * `Wechatpay-Signature`。**这一步不能省**：只解密不验签的话，任何拿到 APIv3 密钥的一方
 * 都能伪造回调；而验签能证明报文确实由微信私钥签发（这段话搬自 knowledge `v3-sign.ts`）。
 *
 * 支持两种模式：把 `credentials` 整个传进来，函数按 `serial` 自己选 PEM。
 *
 * @returns 验签结果与实际用到的 PEM（`pem` 为 `null` 表示序列号根本没匹配上任何已配置的公钥）
 */
export function verifyResponseSignature(input: {
  credentials: WechatPayCredentials
  /** 响应/回调头里的 `Wechatpay-Serial`。 */
  serial: string
  timestamp: string
  nonce: string
  /** **原始报文字节**。重新序列化过的 JSON 一定验不过。 */
  body: string
  signature: string
  extraCerts?: readonly { serialNo: string; certPem: string }[]
}): { ok: boolean; pem: string | null } {
  const pem = selectVerifyPem({
    serial: input.serial,
    publicKeyId: input.credentials.publicKeyId,
    publicKeyPem: input.credentials.publicKeyPem,
    platformSerialNo: input.credentials.platformSerialNo,
    platformCertPem: input.credentials.platformCertPem,
    ...(input.extraCerts ? { extraCerts: input.extraCerts } : {}),
  })
  if (!pem) return { ok: false, pem: null }
  const message = `${input.timestamp}\n${input.nonce}\n${input.body}\n`
  return { ok: rsaSha256Verify(message, input.signature, pem), pem }
}

/** 应答/回调时间戳的容忍窗口（秒），超出即视为重放。 */
export const SIGNATURE_MAX_SKEW_SECONDS = 5 * 60

/**
 * 时间戳是否还新鲜。
 *
 * 验签能挡住伪造，但挡不住**重放**：攻击者原样重发一份真实的旧回调，签名照样是对的。
 * 幂等（按 `transactionId`）是第一道防线，时间窗是第二道。
 */
export function isTimestampFresh(timestamp: string, now: number = Date.now()): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  return Math.abs(now / 1000 - ts) <= SIGNATURE_MAX_SKEW_SECONDS
}

/** JSAPI/小程序调起支付的参数（二次签名结果）。 */
export interface JsapiPayParams {
  appId: string
  timeStamp: string
  nonceStr: string
  /** 固定 `prepay_id=xxx`。 */
  package: string
  signType: 'RSA'
  paySign: string
}

/**
 * JSAPI 调起支付的二次签名。
 *
 * 待签名串是 `appId\ntimeStamp\nnonceStr\npackage\n`。
 * **这里的 `appId` 必须与下单时报文里的 appid 一致**（服务商模式下即 sub_appid），
 * 否则前端只报一句「支付验证签名失败」，看不出是 appid 对不上。
 */
export function signJsapi(input: {
  appId: string
  prepayId: string
  privateKeyPem: string
  nonceStr?: string
  now?: Date
}): JsapiPayParams {
  const timeStamp = currentTimestamp(input.now?.getTime() ?? Date.now())
  const nonceStr = input.nonceStr ?? generateNonce()
  const pkg = `prepay_id=${input.prepayId}`
  const message = `${input.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`
  return {
    appId: input.appId,
    timeStamp,
    nonceStr,
    package: pkg,
    signType: 'RSA',
    paySign: rsaSha256Sign(message, input.privateKeyPem),
  }
}
