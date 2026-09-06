/**
 * 微信支付协议层的类型：凭据、直连/服务商两种配置、注入式 HttpClient。
 *
 * 本包**零框架依赖**：不 import nest、不 import axios、不读 `process.env`。
 * 所有租户凭据从参数进来（多租户下由 `@taizan/crypto` 的 CredentialVault 解密后传入），
 * 所有网络调用走 {@link HttpClient}。这样整包可以在裸 node 下跑单测。
 */
import { PAYMENT_ERROR, PaymentError, type ProviderConfig } from '@taizan/payment-core'

/**
 * 一套微信支付商户凭据。
 *
 * 搬自 xiaodian `libs/wechatpay/src/types.ts` 的 `TenantPayCredentials`，
 * 去掉了 `notifyHost`（回调地址属于「这次下单」而不是「这套凭据」，蓝图里由 CreateOrderReq 传）。
 *
 * ## 平台证书模式 vs 微信支付公钥模式
 *
 * 微信 2024 年起主推「微信支付公钥」：商户平台下载一个公钥 PEM + 一个公钥 ID
 * （形如 `PUB_KEY_ID_...`），不再需要定期下载轮换平台证书。
 * 旧的平台证书模式仍然可用，且**回调头里的 `Wechatpay-Serial` 会告诉你这次用的是哪一种**，
 * 所以两套字段都是可选的，验签时按 serial 选（见 `selectVerifyPem`）。
 * 两套都不配 = 无法验签 = 所有回调都会被拒，这是刻意的。
 */
export interface WechatPayCredentials {
  /** 商户号。服务商模式下这里放**服务商**商户号（签名用的就是它）。 */
  mchId: string
  /** 商户 API 证书序列号。 */
  serialNo: string
  /** 商户 API 私钥 PEM（`-----BEGIN PRIVATE KEY-----` 开头）。 */
  privateKeyPem: string
  /** APIv3 密钥，**必须正好 32 字节**（回调解密用）。 */
  apiV3Key: string
  /** 旧版平台证书序列号。 */
  platformSerialNo?: string
  /** 旧版平台证书 PEM。 */
  platformCertPem?: string
  /** 新版微信支付公钥 ID（`PUB_KEY_ID_...`）。 */
  publicKeyId?: string
  /** 新版微信支付公钥 PEM。 */
  publicKeyPem?: string
}

/** 直连商户模式：钱直接进自己的商户号。 */
export interface WechatPayDirectConfig {
  mode: 'DIRECT'
  /** 发起支付的 appid（公众号/小程序/APP）。`payer.openid` 必须归属它。 */
  appId: string
  credentials: WechatPayCredentials
}

/**
 * 服务商（partner）模式：平台是服务商，钱进特约商户（sub_mchid）。
 *
 * **`credentials.mchId` 是服务商商户号（sp_mchid）**，签名用的也是服务商的证书私钥；
 * `subMchId` 只出现在报文里。这一点最容易搞混：拿特约商户的证书去签服务商接口必然失败。
 */
export interface WechatPayPartnerConfig {
  mode: 'PARTNER'
  /** 服务商的 appid（sp_appid）。 */
  spAppId: string
  /** 特约商户号（sub_mchid）。 */
  subMchId: string
  /**
   * 特约商户自己的 appid（sub_appid）。
   *
   * 小程序一店一号时必填：`openid` 是在**商家自己的小程序** appid 下签发的，
   * 报文里不带 sub_appid 而用 `sp_openid` 表达，微信会直接拒单（openid 与 appid 不匹配）。
   * 搬自 knowledge `wechat-partner.service.ts` 里那段用生产事故换来的注释。
   */
  subAppId?: string
  credentials: WechatPayCredentials
}

/** 微信支付渠道配置（两种模式二选一）。 */
export type WechatPayConfig = WechatPayDirectConfig | WechatPayPartnerConfig

function requireString(source: Record<string, unknown>, key: string, where: string): string {
  const v = source[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw PaymentError.of(
      PAYMENT_ERROR.CONFIG_INVALID,
      `[@taizan/wechatpay] ${where}.${key} 缺失或不是非空字符串`,
      { field: `${where}.${key}` },
    )
  }
  return v
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const v = source[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * 把鸭子类型的 {@link ProviderConfig} narrow 成 {@link WechatPayConfig}。
 *
 * 蓝图 §4.12 把 `ProviderConfig` 定成 `Record<string, unknown>`，**narrow 的责任在各 Provider**。
 * 这里宁可啰嗦地逐字段报错，也不做 `as WechatPayConfig`：配置来自数据库里解密出来的
 * 租户凭据，少一个字段的表现是几百毫秒后微信回一句 `PARAM_ERROR`，指不到是哪一项没配。
 *
 * @throws 形状不对时抛 `PAYMENT_ERROR.CONFIG_INVALID`，message 指到具体字段
 */
export function narrowWechatPayConfig(cfg: ProviderConfig): WechatPayConfig {
  const mode = cfg['mode']
  const credRaw = cfg['credentials']
  if (typeof credRaw !== 'object' || credRaw === null) {
    throw PaymentError.of(PAYMENT_ERROR.CONFIG_INVALID, '[@taizan/wechatpay] 缺少 credentials')
  }
  const c = credRaw as Record<string, unknown>
  const credentials: WechatPayCredentials = {
    mchId: requireString(c, 'mchId', 'credentials'),
    serialNo: requireString(c, 'serialNo', 'credentials'),
    privateKeyPem: requireString(c, 'privateKeyPem', 'credentials'),
    apiV3Key: requireString(c, 'apiV3Key', 'credentials'),
  }
  const platformSerialNo = optionalString(c, 'platformSerialNo')
  const platformCertPem = optionalString(c, 'platformCertPem')
  const publicKeyId = optionalString(c, 'publicKeyId')
  const publicKeyPem = optionalString(c, 'publicKeyPem')
  if (platformSerialNo) credentials.platformSerialNo = platformSerialNo
  if (platformCertPem) credentials.platformCertPem = platformCertPem
  if (publicKeyId) credentials.publicKeyId = publicKeyId
  if (publicKeyPem) credentials.publicKeyPem = publicKeyPem

  if (mode === 'PARTNER') {
    const partner: WechatPayPartnerConfig = {
      mode: 'PARTNER',
      spAppId: requireString(cfg, 'spAppId', 'config'),
      subMchId: requireString(cfg, 'subMchId', 'config'),
      credentials,
    }
    const subAppId = optionalString(cfg, 'subAppId')
    if (subAppId) partner.subAppId = subAppId
    return partner
  }
  if (mode === 'DIRECT' || mode === undefined) {
    return { mode: 'DIRECT', appId: requireString(cfg, 'appId', 'config'), credentials }
  }
  throw PaymentError.of(
    PAYMENT_ERROR.CONFIG_INVALID,
    `[@taizan/wechatpay] mode 只能是 'DIRECT' 或 'PARTNER'，收到 ${String(mode)}`,
  )
}

/**
 * 这次支付实际使用的 appid。
 *
 * 服务商模式下**优先 sub_appid**（商家自己的小程序），因为 openid 归属它；
 * 没有 sub_appid 才回落到 sp_appid。JSAPI 二次签名必须用这个值，
 * 与下单报文里的 appid 不一致时前端报「支付验证签名失败」。
 */
export function payAppId(cfg: WechatPayConfig): string {
  return cfg.mode === 'DIRECT' ? cfg.appId : (cfg.subAppId ?? cfg.spAppId)
}

/** HTTP 请求（fetch 风格的最小子集）。 */
export interface HttpRequest {
  method: 'GET' | 'POST'
  /** 完整 URL（含 query）。 */
  url: string
  headers: Record<string, string>
  /**
   * 请求体。
   *
   * **必须与签名时用的那串字节完全一致**：传字符串就原样发出去，
   * 交给 HTTP 库重新序列化对象是签名必挂的经典错误（xiaodian 那边靠
   * `transformRequest: [(d) => d]` 关掉 axios 的二次序列化，我们干脆不给对象）。
   */
  body?: string | Uint8Array
}

/** HTTP 响应。`body` 是原始文本——**验签验的就是这串字节**，不要先 `JSON.parse`。 */
export interface HttpResponse {
  status: number
  /** 响应头，键统一小写。 */
  headers: Record<string, string>
  body: string
}

/**
 * 注入式 HTTP 客户端。
 *
 * 做成接口而不是直接 `fetch`，一是为了单测能塞假实现（本包所有网络路径的用例都靠它），
 * 二是为了让上层自己决定超时、重试、连接池、代理——那些是应用的事，不是协议层的事。
 */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
}

/**
 * 用全局 `fetch`（Node 18+ 原生）实现的 {@link HttpClient}。
 *
 * @param fetchImpl - 自定义 fetch 实现，默认 `globalThis.fetch`
 * @param timeoutMs - 单次请求超时，默认 10 秒（微信侧 P99 在 1s 内，10s 已经很宽）
 */
export function createFetchHttpClient(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 10_000,
): HttpClient {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      return { status: res.status, headers, body: await res.text() }
    },
  }
}

/** 支付方式。付款码（codepay）与 APP 支付暂未接，需要时按同一形状加。 */
export type TradeType = 'JSAPI' | 'NATIVE' | 'H5'

/** 微信 API 网关地址。 */
export const WECHATPAY_API_BASE = 'https://api.mch.weixin.qq.com'
