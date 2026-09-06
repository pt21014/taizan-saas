/**
 * 对象存储 Provider 的统一形状。
 *
 * `TConfig` 是具体厂商的配置（COS 要 secretId/secretKey/bucket/region，
 * VOD 是另一套），刻意不统一成一个大而全的对象——理由与 `@taizan/sms` 的
 * `SmsProvider<TConfig>` 一样。
 */

/** `putObject` 的入参。 */
export interface PutObjectRequest {
  /** 完整 key，调用方必须已经用 `buildTenantKey`/`buildPlatformKey` 生成过。 */
  key: string
  body: Buffer
  /** 扩展名（含前导 `.`），决定 Content-Type，也用于 ACL 之外的元数据。 */
  ext: string
  /** ACL：`true` = 公开读（图片走 CDN），`false` = 私有（音频/文档，访问要走 presignGet）。 */
  public: boolean
}

export interface PutObjectResult {
  key: string
  /** 厂商返回的 ETag，可用于校验，未提供时为空。 */
  etag?: string
}

/** `presignGet`（私读临时地址）的入参。 */
export interface PresignGetOptions {
  /** 有效期（秒）。 */
  expireSeconds: number
}

/** `presignPut`（浏览器/小程序直传）的入参。 */
export interface PresignPutOptions {
  /** 有效期（秒）。 */
  expireSeconds: number
  /** 直传时客户端必须携带的 Content-Type，不传则不限制。 */
  contentType?: string
}

/** `presignPut` 的返回值：客户端拿它直接发 HTTP 请求，不经过业务后端中转。 */
export interface PresignPutResult {
  url: string
  method: 'PUT'
  /** 直传请求必须带上的请求头（例如 Content-Type）。 */
  headers: Record<string, string>
}

export interface StorageProvider<TConfig = unknown> {
  readonly name: string
  putObject(req: PutObjectRequest, cfg: TConfig): Promise<PutObjectResult>
  /** 公开对象的访问地址（不校验对象是否真的是 public，调用方保证 ACL 与调用点匹配）。 */
  getPublicUrl(key: string, cfg: TConfig): string
  /** 私有对象的临时访问地址。 */
  presignGet(key: string, opts: PresignGetOptions, cfg: TConfig): string
  /** 直传签名：把签名 URL 直接交给前端，文件不经过业务进程。 */
  presignPut(key: string, opts: PresignPutOptions, cfg: TConfig): PresignPutResult
  deleteObject(key: string, cfg: TConfig): Promise<void>
}
