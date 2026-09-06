/**
 * 腾讯云 API 签名 v3（TC3-HMAC-SHA256）+ `SendSms` provider。
 *
 * 签名部分照搬自 `D:\project\knowledge\apps\api\src\infra\tencent\tc3-sign.ts`
 * （所有腾讯云产品公用的那一份，短信只是调用方之一）。做成纯函数、单独导出，
 * 理由写在函数注释里：签名错了只会得到一句「签名验证失败」，唯一能提前发现的
 * 办法是逐字节对照官方样例。
 */
import * as crypto from 'node:crypto'
import type { HttpClient } from '../http-client'
import type { SmsProvider, SmsResult, SmsSendRequest } from '../provider'
import { resolveTemplateParams, requireTemplate, type SmsTemplateRegistry } from '../templates'

const sha256hex = (s: string | Buffer): string =>
  crypto.createHash('sha256').update(s).digest('hex')
const hmac = (key: Buffer | string, data: string): Buffer =>
  crypto.createHmac('sha256', key).update(data).digest()

/** {@link tc3Authorization} 的入参。 */
export interface Tc3Input {
  secretId: string
  secretKey: string
  service: string
  host: string
  action: string
  version: string
  region?: string
  payload: string
  /** 秒级时间戳。传进来而不是内部取，是为了能对着官方样例测。 */
  timestamp: number
}

/**
 * 腾讯云 TC3-HMAC-SHA256 的 Authorization 头。
 *
 * 三个容易错的地方：
 * 1. `CanonicalHeaders` 的 key **必须小写且按字典序**，值要去掉首尾空格，
 *    每行以 `\n` 结尾——少一个换行整段哈希就变了；
 * 2. 日期用 **UTC**，不是本地时区，本地时区在 UTC+8 会有 8 小时里签不对；
 * 3. `content-type` 要与真正发出去的请求头一致，包括 `; charset=utf-8` 这段。
 */
export function tc3Authorization(input: Tc3Input): {
  authorization: string
  timestamp: number
  /**
   * 中间量一并返回，专供测试断言。
   *
   * 腾讯云文档把示例的 SecretId 打了码（`AKID****`），所以它公布的最终 Signature
   * **是复现不出来的**。但 CanonicalRequest 与 StringToSign 的每一个输入它都
   * 公布了——断言这两个才是真正在对照官方数据。
   */
  canonicalRequest: string
  stringToSign: string
} {
  const { secretId, secretKey, service, host, action, payload, timestamp } = input
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)

  const contentType = 'application/json; charset=utf-8'
  const canonicalHeaders =
    `content-type:${contentType}\n` + `host:${host}\n` + `x-tc-action:${action.toLowerCase()}\n`
  const signedHeaders = 'content-type;host;x-tc-action'

  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256hex(payload),
  ].join('\n')

  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n')

  const kDate = hmac(`TC3${secretKey}`, date)
  const kService = hmac(kDate, service)
  const kSigning = hmac(kService, 'tc3_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  return {
    authorization:
      `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    timestamp,
    canonicalRequest,
    stringToSign,
  }
}

/** 腾讯云短信 provider 的配置。 */
export interface TencentSmsConfig {
  secretId: string
  secretKey: string
  /** 短信应用 SdkAppId（控制台「应用管理」里的）。 */
  sdkAppId: string
  /** 短信签名（不传则用 `SmsSendRequest.signName`）。 */
  signName?: string
  region?: string
  /** 覆盖默认 host，便于测试打向假服务器。 */
  host?: string
  templates: SmsTemplateRegistry
}

const DEFAULT_HOST = 'sms.tencentcloudapi.com'
const ACTION = 'SendSms'
const VERSION = '2021-01-11'

interface TencentSendSmsResponse {
  Response?: {
    SendStatusSet?: Array<{ Code?: string; Message?: string; SerialNo?: string }>
    Error?: { Code?: string; Message?: string }
    RequestId?: string
  }
}

/** 腾讯云 `SendSms` provider。HTTP 走注入的 {@link HttpClient}，不直接依赖任何网络库。 */
export class TencentTc3SmsProvider implements SmsProvider<TencentSmsConfig> {
  readonly name = 'tencent-tc3'

  constructor(private readonly http: HttpClient) {}

  async send(req: SmsSendRequest, cfg: TencentSmsConfig): Promise<SmsResult> {
    const host = cfg.host ?? DEFAULT_HOST
    const def = requireTemplate(cfg.templates, req.templateKey)
    const params = resolveTemplateParams(def, req.params)
    const signName = req.signName ?? cfg.signName
    if (!signName) {
      return { ok: false, provider: this.name, error: '缺少短信签名（signName）' }
    }

    const payload = JSON.stringify({
      PhoneNumberSet: [`+86${req.phone}`],
      SmsSdkAppId: cfg.sdkAppId,
      SignName: signName,
      TemplateId: def.providerTemplateId,
      TemplateParamSet: params,
    })

    const timestamp = Math.floor(Date.now() / 1000)
    const { authorization } = tc3Authorization({
      secretId: cfg.secretId,
      secretKey: cfg.secretKey,
      service: 'sms',
      host,
      action: ACTION,
      version: VERSION,
      region: cfg.region,
      payload,
      timestamp,
    })

    try {
      const res = await this.http.post(`https://${host}/`, payload, {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        'X-TC-Action': ACTION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': VERSION,
        ...(cfg.region ? { 'X-TC-Region': cfg.region } : {}),
      })

      const body = safeParseJson(res.body) as TencentSendSmsResponse
      if (res.status !== 200 || body.Response?.Error) {
        return {
          ok: false,
          provider: this.name,
          error: body.Response?.Error?.Message ?? `HTTP ${res.status}`,
          raw: body,
        }
      }
      // 整体 200 不代表这条发出去了——腾讯云要看逐号码状态。
      const status = body.Response?.SendStatusSet?.[0]
      if (!status || status.Code !== 'Ok') {
        return {
          ok: false,
          provider: this.name,
          error: status?.Message ?? '未知错误',
          vendorRef: status?.SerialNo,
          raw: body,
        }
      }
      return { ok: true, provider: this.name, vendorRef: status.SerialNo, raw: body }
    } catch (err) {
      // 网络异常也要当成失败返回值，不要抛出去——调用方要靠返回值决定扣不扣额度。
      return { ok: false, provider: this.name, error: messageOf(err) }
    }
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
