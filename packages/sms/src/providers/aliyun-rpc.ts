/**
 * 阿里云 RPC 风格签名（HMAC-SHA1）+ `SendSms` provider。
 *
 * 签名部分照搬自 `D:\project\knowledge\apps\api\src\infra\sms\sign.ts`。
 * 与 TC3 完全不同的算法，别照抄：参数排序拼串，HMAC-SHA1，且百分号编码有
 * 三处特例。
 */
import * as crypto from 'node:crypto'
import type { HttpClient } from '../http-client'
import type { SmsProvider, SmsResult, SmsSendRequest } from '../provider'
import { resolveTemplateParams, requireTemplate, type SmsTemplateRegistry } from '../templates'

/**
 * 阿里云的百分号编码。
 *
 * 在 `encodeURIComponent` 基础上还要改三处：`+`→`%20`、`*`→`%2A`、`%7E`→`~`。
 * 这三处不改，带空格或星号的短信内容就签不过——而报错只会说「签名不合法」。
 */
export function aliyunPercentEncode(s: string): string {
  return encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')
}

/** 规范化查询串：按 key 字典序，逐个编码后用 `&` 连接。 */
export function canonicalizedQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k]!)}`)
    .join('&')
}

/**
 * 待签名串。单独导出是为了能对着官方文档公布的那一段逐字比对。
 *
 * 关键点：**HTTP 方法参与签名**，必须与真正发出去的那个一致——写死一个再用
 * 另一个发，签名恒不通过，而报错只说「签名不合法」，不会提示方法对不上。
 * （官方样例用的是 GET，照抄成 POST 就中招。）
 */
export function aliyunStringToSign(
  params: Record<string, string>,
  method: 'GET' | 'POST' = 'POST',
): string {
  const sorted = canonicalizedQuery(params)
  return `${method}&${aliyunPercentEncode('/')}&${aliyunPercentEncode(sorted)}`
}

/**
 * 阿里云 RPC 风格签名（短信 SendSms 用的就是这套）。
 *
 * 密钥要在末尾加一个 `&`——这不是笔误，是阿里云的规定。
 */
export function aliyunRpcSignature(
  params: Record<string, string>,
  accessSecret: string,
  method: 'GET' | 'POST' = 'POST',
): string {
  return crypto
    .createHmac('sha1', `${accessSecret}&`)
    .update(aliyunStringToSign(params, method))
    .digest('base64')
}

/** 随机串。阿里云要求每次请求的 SignatureNonce 不同，用来防重放。 */
export function nonce(): string {
  return crypto.randomBytes(16).toString('hex')
}

/** 阿里云要的时间格式是 ISO8601 UTC，且**必须带 Z**，不能用本地时区。 */
export function aliyunTimestamp(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`
}

/** 阿里云短信 provider 的配置。 */
export interface AliyunSmsConfig {
  accessKeyId: string
  accessKeySecret: string
  signName: string
  /** 覆盖默认 endpoint，便于测试打向假服务器。 */
  endpoint?: string
  templates: SmsTemplateRegistry
}

const DEFAULT_ENDPOINT = 'https://dysmsapi.aliyuncs.com/'

interface AliyunSendSmsResponse {
  Code?: string
  Message?: string
  BizId?: string
  RequestId?: string
}

/** 阿里云 `SendSms` provider。HTTP 走注入的 {@link HttpClient}，不直接依赖任何网络库。 */
export class AliyunRpcSmsProvider implements SmsProvider<AliyunSmsConfig> {
  readonly name = 'aliyun-rpc'

  constructor(private readonly http: HttpClient) {}

  async send(req: SmsSendRequest, cfg: AliyunSmsConfig): Promise<SmsResult> {
    const def = requireTemplate(cfg.templates, req.templateKey)
    const orderedParams = resolveTemplateParams(def, req.params)
    // 阿里云的模板变量在请求里是一个 JSON 对象字符串——但对象内部的键序不参与
    // 「顺序替换」，真正决定替换顺序的是模板本身 `${name}` 出现的顺序；
    // 这里仍然用 paramOrder 里声明的变量名做键，只是外壳要求是对象而不是数组。
    const templateParam = Object.fromEntries(
      def.paramOrder.map((key, i) => [key, orderedParams[i]]),
    )

    const signName = req.signName ?? cfg.signName

    const query: Record<string, string> = {
      AccessKeyId: cfg.accessKeyId,
      Action: 'SendSms',
      Format: 'JSON',
      PhoneNumbers: req.phone,
      RegionId: 'cn-hangzhou',
      SignName: signName,
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: nonce(),
      SignatureVersion: '1.0',
      TemplateCode: def.providerTemplateId,
      TemplateParam: JSON.stringify(templateParam),
      Timestamp: aliyunTimestamp(new Date()),
      Version: '2017-05-25',
    }
    const signature = aliyunRpcSignature(query, cfg.accessKeySecret, 'POST')
    const body = canonicalizedQuery({ ...query, Signature: signature })

    try {
      const res = await this.http.post(cfg.endpoint ?? DEFAULT_ENDPOINT, body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      })
      const parsed = safeParseJson(res.body) as AliyunSendSmsResponse
      if (res.status !== 200 || parsed.Code !== 'OK') {
        return {
          ok: false,
          provider: this.name,
          error: parsed.Message ?? `HTTP ${res.status}`,
          raw: parsed,
        }
      }
      return { ok: true, provider: this.name, vendorRef: parsed.BizId, raw: parsed }
    } catch (err) {
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
