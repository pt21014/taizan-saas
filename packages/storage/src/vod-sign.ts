/**
 * 腾讯云点播（VOD）的两种签名：客户端上传签名、播放地址防盗链 Key。
 *
 * 照搬自 `D:\project\knowledge\apps\api\src\infra\tencent\vod-sign.ts`。纯函数、
 * 无 IO，便于单测——签错的直接后果是视频传不上去或播不出来，线上排查成本很高。
 *
 * 防盗链**只能用 Key 模式，不能用 Referer 白名单**：iOS 微信的 WebKit 拉
 * `<video>`（尤其 Range 请求）不带 Referer，安卓 X5 会带——同一个链接安卓能播、
 * iPhone 一律 403。Key 模式不依赖 Referer，两端表现一致。
 */
import * as crypto from 'node:crypto'

/**
 * 客户端上传签名。
 *
 * 算法（官方文档 266/9221）：
 * ```
 * original  = "secretId=..&currentTimeStamp=..&expireTime=..&random=.."（可追加可选参数）
 * signature = base64( HMAC-SHA1(secretKey, original) 的原始字节 ++ original 的 UTF-8 字节 )
 * ```
 * 注意是"HMAC 原始字节拼在 original 前面再整体 base64"，不是常见的
 * "base64(hmac) + original"，写错了服务端会返回签名校验失败。
 */
export function buildVodUploadSignature(params: {
  secretId: string
  secretKey: string
  /** 有效期（秒）。 */
  expireSeconds: number
  /** 子应用 ID，0 表示主应用。 */
  subAppId?: number
  /** 上传完成后触发的任务流（转码/截图等），不填则只存原片。 */
  procedure?: string
  now?: Date
}): string {
  const current = Math.floor((params.now?.getTime() ?? Date.now()) / 1000)
  const expire = current + params.expireSeconds
  const random = crypto.randomInt(0, 4294967295)

  const parts = [
    `secretId=${encodeURIComponent(params.secretId)}`,
    `currentTimeStamp=${current}`,
    `expireTime=${expire}`,
    `random=${random}`,
  ]
  if (params.procedure) parts.push(`procedure=${encodeURIComponent(params.procedure)}`)
  if (params.subAppId) parts.push(`vodSubAppId=${params.subAppId}`)

  const original = parts.join('&')
  const hmac = crypto.createHmac('sha1', params.secretKey).update(original, 'utf8').digest()
  return Buffer.concat([hmac, Buffer.from(original, 'utf8')]).toString('base64')
}

export interface PlayUrlOptions {
  /** 播放地址有效期（秒）。 */
  expireSeconds: number
  /** 试看时长（秒）。设了它，未购买的用户也能看前 N 秒。 */
  previewSeconds?: number
  /** 允许播放的不同 IP 数上限，不填表示不限制。 */
  ipLimit?: number
  now?: Date
}

/**
 * Key 防盗链签名。
 *
 * 算法（官方文档 266/14047）：
 * ```
 * sign = md5(KEY + Dir + t + exper + rlimit + us)
 * ```
 * - `Dir`：URL 路径中去掉文件名的部分，含首尾斜杠，如 `/dir1/dir2/`
 * - `t`：过期时间戳，十六进制小写
 * - `exper`：试看时长（十进制秒），可省略
 * - `rlimit`：IP 数限制（十进制），可省略
 * - `us`：随机串
 * - 省略的可选参数在拼接时按空字符串处理
 * - QueryString 必须按 `t、exper、rlimit、us、sign` 的顺序排列
 */
export function signVodPlayUrl(rawUrl: string, key: string, opts: PlayUrlOptions): string {
  const url = new URL(rawUrl)
  const path = url.pathname
  const dir = path.slice(0, path.lastIndexOf('/') + 1)

  const now = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000)
  const t = (now + opts.expireSeconds).toString(16).toLowerCase()
  const exper = opts.previewSeconds != null ? String(opts.previewSeconds) : ''
  const rlimit = opts.ipLimit != null ? String(opts.ipLimit) : ''
  const us = crypto.randomBytes(5).toString('hex')

  const sign = crypto
    .createHash('md5')
    .update(key + dir + t + exper + rlimit + us, 'utf8')
    .digest('hex')

  const qs = [`t=${t}`]
  if (exper) qs.push(`exper=${exper}`)
  if (rlimit) qs.push(`rlimit=${rlimit}`)
  qs.push(`us=${us}`, `sign=${sign}`)

  url.search = qs.join('&')
  return url.toString()
}
