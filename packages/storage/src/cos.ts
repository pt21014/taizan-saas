/**
 * 腾讯云 COS 签名 v5（`q-sign-algorithm=sha1`）+ `StorageProvider` 实现。
 *
 * 算法照搬自腾讯云官方 Python SDK `qcloud_cos/cos_auth.py`（`CosS3Auth.__call__`），
 * 这是官方对外发布、生产在用的实现，比转述文档更可信。核心步骤：
 *
 * 1. `KeyTime = "{start};{end}"`（秒级时间戳）
 * 2. `SignKey = HMAC-SHA1(SecretKey, KeyTime)` 的 **hex** 串
 * 3. `HttpString = "{method}\n{path}\n{排序后的query}\n{排序后的header}\n"`
 *    —— method 小写；path **原样使用，不做百分号编码**（含中文/括号也是字面写入，
 *    这一点与常见的"路径要编码"直觉相反，官方文档的示例就是证据）；
 *    query/header 的 **key 小写**，key/value 各自百分号编码后按 key 字典序拼接。
 * 4. `StringToSign = "sha1\n{KeyTime}\n{sha1hex(HttpString)}\n"`
 * 5. `Signature = HMAC-SHA1(SignKey 的 hex 串本身当作字符串 key, StringToSign)` 的 hex
 * 6. `Authorization = "q-sign-algorithm=sha1&q-ak={id}&q-sign-time={KeyTime}&` +
 *    `q-key-time={KeyTime}&q-header-list={header keys}&q-url-param-list={param keys}&` +
 *    `q-signature={Signature}"`
 *
 * 百分号编码比 `encodeURIComponent` 严格：Python `quote(s, safe='-_.~')` 只放行
 * 字母/数字/`_.-~`，`encodeURIComponent` 还额外放行 `! * ' ( )`，这五个字符要
 * 再手动编码一次，否则遇到这几个字符签名会跟官方 SDK 对不上。
 */
import * as crypto from 'node:crypto'
import type { HttpClient } from './http-client'
import { assertValidExpireSeconds } from './presign'
import { contentTypeOf } from './mime'
import type {
  PresignGetOptions,
  PresignPutOptions,
  PresignPutResult,
  PutObjectRequest,
  PutObjectResult,
  StorageProvider,
} from './provider'

/** COS 严格百分号编码：`encodeURIComponent` 基础上再编码 `! * ' ( )`。 */
export function cosPercentEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** 把 `{key: value}` 排序后拼成 `k1=v1&k2=v2`，key 先转小写再编码。 */
function joinSorted(pairs: Record<string, string>): { joined: string; keys: string[] } {
  const lowered = Object.entries(pairs).map(([k, v]) => [k.toLowerCase(), v] as const)
  const sorted = [...lowered].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    joined: sorted.map(([k, v]) => `${cosPercentEncode(k)}=${cosPercentEncode(v)}`).join('&'),
    keys: sorted.map(([k]) => k),
  }
}

/** {@link cosAuthorization} 的入参。 */
export interface CosSignInput {
  secretId: string
  secretKey: string
  /** HTTP 方法，会被转成小写参与签名。 */
  method: string
  /** URL 路径，含前导 `/`，**原样传入，不要预先编码**。 */
  pathname: string
  /** 参与签名的 query 参数（presign 场景下就是最终 URL 上除签名字段外的那些）。 */
  params?: Record<string, string>
  /** 参与签名的请求头。 */
  headers?: Record<string, string>
  /** KeyTime 起始时间戳（秒）。 */
  startTimestamp: number
  /** KeyTime 结束时间戳（秒）。 */
  endTimestamp: number
}

/** {@link cosAuthorization} 的返回值，中间量一并暴露供测试断言。 */
export interface CosSignResult {
  keyTime: string
  signKey: string
  httpString: string
  stringToSign: string
  signature: string
  /** 完整的 `q-sign-algorithm=...` 字符串，可直接当 `Authorization` 头或拼进 URL query。 */
  authorization: string
}

export function cosAuthorization(input: CosSignInput): CosSignResult {
  const keyTime = `${input.startTimestamp};${input.endTimestamp}`
  const signKey = crypto.createHmac('sha1', input.secretKey).update(keyTime).digest('hex')

  const { joined: paramString, keys: paramKeys } = joinSorted(input.params ?? {})
  const { joined: headerString, keys: headerKeys } = joinSorted(input.headers ?? {})

  const httpString = `${input.method.toLowerCase()}\n${input.pathname}\n${paramString}\n${headerString}\n`
  const httpStringHash = crypto.createHash('sha1').update(httpString, 'utf8').digest('hex')
  const stringToSign = `sha1\n${keyTime}\n${httpStringHash}\n`

  // 注意：SignKey 是上一步算出的 hex 字符串，这里把它当**字符串**（不是先解码回原始字节）
  // 当 HMAC 的 key——这是官方 SDK 的写法，写反了签名会恒错但报错依旧只说"签名验证失败"。
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign, 'utf8').digest('hex')

  const authorization =
    `q-sign-algorithm=sha1&q-ak=${input.secretId}&q-sign-time=${keyTime}&` +
    `q-key-time=${keyTime}&q-header-list=${headerKeys.join(';')}&` +
    `q-url-param-list=${paramKeys.join(';')}&q-signature=${signature}`

  return { keyTime, signKey, httpString, stringToSign, signature, authorization }
}

/** COS provider 的配置。公读桶与私读桶各自一套配置，用两个 `CosConfig` 实例区分。 */
export interface CosConfig {
  secretId: string
  secretKey: string
  bucket: string
  region: string
  /** 公开访问用的 CDN 域名；不传则用 COS 源站域名。 */
  cdnDomain?: string
  /** 覆盖 host，便于测试打向假域名。 */
  host?: string
}

function hostOf(cfg: CosConfig): string {
  return cfg.host ?? `${cfg.bucket}.cos.${cfg.region}.myqcloud.com`
}

/** COS 要求 key 的路径要以 `/` 开头，且路径分段要 URL 编码（但 `/` 本身不编码）。 */
function encodePath(key: string): string {
  return `/${key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`
}

const SKEW_BUFFER_SECONDS = 60

function keyTimeWindow(
  expireSeconds: number,
  now = Math.floor(Date.now() / 1000),
): [number, number] {
  return [now - SKEW_BUFFER_SECONDS, now + expireSeconds]
}

/**
 * 腾讯云 COS `StorageProvider` 实现。
 *
 * `putObject`/`deleteObject` 走注入的 {@link HttpClient}（服务端中转场景）；
 * `presignGet`/`presignPut` 是纯函数式的 URL 拼装，不发请求——直传/私读地址
 * 本来就是"签出来交给别人用"，本包不需要为此持有网络连接。
 */
export class CosStorageProvider implements StorageProvider<CosConfig> {
  readonly name = 'tencent-cos'

  constructor(private readonly http: HttpClient) {}

  async putObject(req: PutObjectRequest, cfg: CosConfig): Promise<PutObjectResult> {
    const host = hostOf(cfg)
    const pathname = encodePath(req.key)
    const contentType = contentTypeOf(req.ext)
    const headers: Record<string, string> = {
      host,
      'content-length': String(req.body.length),
      'content-type': contentType,
      'x-cos-acl': req.public ? 'public-read' : 'private',
    }
    const now = Math.floor(Date.now() / 1000)
    const [start, end] = keyTimeWindow(300, now)
    const { authorization } = cosAuthorization({
      secretId: cfg.secretId,
      secretKey: cfg.secretKey,
      method: 'put',
      pathname,
      headers,
      startTimestamp: start,
      endTimestamp: end,
    })

    const res = await this.http.request('PUT', `https://${host}${pathname}`, req.body, {
      ...headers,
      Authorization: authorization,
    })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`[@taizan/storage] COS putObject 失败：HTTP ${res.status}`)
    }
    return { key: req.key, etag: res.headers?.etag }
  }

  getPublicUrl(key: string, cfg: CosConfig): string {
    const base = cfg.cdnDomain ?? `https://${hostOf(cfg)}`
    return `${base.replace(/\/$/, '')}/${key}`
  }

  presignGet(key: string, opts: PresignGetOptions, cfg: CosConfig): string {
    assertValidExpireSeconds(opts.expireSeconds)
    const host = hostOf(cfg)
    const pathname = encodePath(key)
    const [start, end] = keyTimeWindow(opts.expireSeconds)
    const { authorization } = cosAuthorization({
      secretId: cfg.secretId,
      secretKey: cfg.secretKey,
      method: 'get',
      pathname,
      startTimestamp: start,
      endTimestamp: end,
    })
    // 私有对象的预签名地址**只能用源站域名**，CDN 域名验不过这个签名——
    // 签名绑定的是发起请求的那个 host，CDN 回源时 host 对不上就会被拒。
    return `https://${host}${pathname}?${authorization}`
  }

  presignPut(key: string, opts: PresignPutOptions, cfg: CosConfig): PresignPutResult {
    assertValidExpireSeconds(opts.expireSeconds)
    const host = hostOf(cfg)
    const pathname = encodePath(key)
    const contentType = opts.contentType ?? contentTypeOf(extOf(key))
    const headers = { host, 'content-type': contentType }
    const [start, end] = keyTimeWindow(opts.expireSeconds)
    const { authorization } = cosAuthorization({
      secretId: cfg.secretId,
      secretKey: cfg.secretKey,
      method: 'put',
      pathname,
      headers,
      startTimestamp: start,
      endTimestamp: end,
    })
    return {
      url: `https://${host}${pathname}?${authorization}`,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
    }
  }

  async deleteObject(key: string, cfg: CosConfig): Promise<void> {
    const host = hostOf(cfg)
    const pathname = encodePath(key)
    const headers = { host }
    const now = Math.floor(Date.now() / 1000)
    const [start, end] = keyTimeWindow(300, now)
    const { authorization } = cosAuthorization({
      secretId: cfg.secretId,
      secretKey: cfg.secretKey,
      method: 'delete',
      pathname,
      headers,
      startTimestamp: start,
      endTimestamp: end,
    })
    const res = await this.http.request('DELETE', `https://${host}${pathname}`, undefined, {
      ...headers,
      Authorization: authorization,
    })
    // COS 删除一个不存在的对象也返回 204，所以只有真正的错误状态码才算失败。
    if (res.status >= 300 && res.status !== 404) {
      throw new Error(`[@taizan/storage] COS deleteObject 失败：HTTP ${res.status}`)
    }
  }
}

function extOf(key: string): string {
  const i = key.lastIndexOf('.')
  return i === -1 ? '' : key.slice(i)
}
