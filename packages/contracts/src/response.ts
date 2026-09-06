/**
 * 四端统一响应包（蓝图 §4.9）。
 *
 * 所有 HTTP 接口——除被 `@RawResponse()` 标注的逃生口（支付回调、文件下载）外——
 * 都必须返回这个结构。传输层错误（401/403/404/429/500 等）与业务错误一样，
 * 由 `@taizan/nest-core` 的全局 filter 统一包成这层信封，前端只需处理一种形状。
 */
export interface ApiResponse<T = unknown> {
  /** 业务码：`0` 表示成功；非 0 见 `error-codes.ts` 的 7 位错误码方案。 */
  code: number
  /** 面向用户的默认中文提示；前端可直接展示，也可按 `code` 自行替换文案。 */
  message: string
  /** 业务数据；失败时固定为 `null`。 */
  data: T
}

/** 成功码，恒为 `0`。 */
export const SUCCESS_CODE = 0

/**
 * 构造一个成功响应包。
 *
 * @param data - 业务数据
 * @param message - 提示文案，默认 `'OK'`
 */
export function ok<T>(data: T, message = 'OK'): ApiResponse<T> {
  return { code: SUCCESS_CODE, message, data }
}

/**
 * 构造一个失败响应包，`data` 固定为 `null`。
 *
 * @param code - 非 0 的业务错误码，见 `error-codes.ts`
 * @param message - 面向用户的中文提示
 * @throws 当 `code === 0` 时抛出——失败响应不允许使用成功码，这类调用点是写反了的 bug。
 */
export function fail(code: number, message: string): ApiResponse<null> {
  if (code === SUCCESS_CODE) {
    throw new Error('[@taizan/contracts] fail() 不允许使用成功码 0，请检查调用方是否写反')
  }
  return { code, message, data: null }
}

/**
 * 判断一个响应包是否代表业务成功。
 *
 * @param res - 待判定的响应包
 */
export function isOk<T>(res: ApiResponse<T>): boolean {
  return res.code === SUCCESS_CODE
}
