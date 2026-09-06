import { ErrorCode, type ErrorCodeDef } from '@taizan/contracts'

/**
 * 业务异常（蓝图 §4.9）。
 *
 * 抛它 → HTTP **200** + 响应包里的业务码。传输层错误（401/403/404/429/500）
 * 请继续抛 Nest 的 `HttpException`，`AllExceptionsFilter` 会把它们也包成同一个信封。
 *
 * 为什么业务错误走 200：前端 axios/fetch 对非 2xx 会走 reject 分支，
 * 而「优惠券已被领完」这类结果本质上是一次**成功的**请求，让它进 catch 会逼着每个调用点
 * 都写 try/catch 去区分「网络挂了」和「业务不允许」。统一 200 + code 后，
 * `@taizan/contracts` 的 `createEnvelopeClient` 一处剥包，业务代码只处理 code。
 */
export class BizException extends Error {
  override readonly name = 'BizException'
  /** 7 位业务错误码 */
  readonly code: number
  /** 附加数据，会原样放进响应包的 `data`（例如配额超限时回传当前用量） */
  readonly data: unknown

  /**
   * @param code - 7 位错误码，或 `@taizan/contracts` 的 `ErrorCode.XXX` 定义对象
   * @param message - 覆盖默认文案；传 `ErrorCodeDef` 且不传 message 时用表里的中文默认值
   * @param data - 附加数据，默认 `null`
   */
  constructor(code: number | ErrorCodeDef, message?: string, data: unknown = null) {
    const resolved = typeof code === 'number' ? { code, message: undefined } : code
    super(message ?? resolved.message ?? '业务处理失败')
    this.code = resolved.code
    this.data = data
  }

  /** 参数错误（`1040000`）。 */
  static badRequest(message?: string, data?: unknown): BizException {
    return new BizException(ErrorCode.BAD_REQUEST, message, data)
  }

  /**
   * 无权限（`1340300`，RBAC 域段）。
   *
   * 全仓只有这一个「无权限」：11 段（认证）那条 `1140301` 已删除——两个码同时存在时，
   * 前端表里躺着两个「无权限」，而实际只会收到 13 段这个。
   * 注意跨租户越权请用 `ErrorCode.CROSS_TENANT_FORBIDDEN`，两者前端动作不同。
   */
  static forbidden(message?: string, data?: unknown): BizException {
    return new BizException(ErrorCode.RBAC_FORBIDDEN, message, data)
  }
}
