/**
 * 限流触顶抛的异常。
 *
 * ## 为什么是 `HttpException(429)` 而不是 `BizException`
 *
 * 框架的通例是「业务错误走 HTTP 200 + 业务码」（蓝图 §4.9），限流是**例外**，
 * 理由有两条：
 *
 * 1. **429 是给机器看的**。浏览器、`fetch` 的重试库、CDN、监控告警、
 *    以及 nginx 的 `limit_req` 之类的上游组件，都认这个状态码。回 200 的话
 *    「被限流了」这件事在整条链路上只有我们自己知道。
 * 2. `Retry-After` 是 429 的配套头，回 200 时它没有标准含义。
 *
 * 响应体仍然是统一信封：`AllExceptionsFilter` 见到 `HttpException` 会用
 * `transportErrorCode(429)` 组出 **`1042900`**（= `ErrorCode.TOO_MANY_REQUESTS`），
 * 所以前端那一行 `httpSemantic(code) === 429` 照样成立，不需要为限流开特例。
 *
 * @packageDocumentation
 */

import { HttpException, HttpStatus } from '@nestjs/common'
import type { RateLimitDimension } from '@taizan/ratelimit-core'

/** 限流触顶。HTTP 429，响应体里的业务码是 `1042900`。 */
export class RateLimitedException extends HttpException {
  /** 还要等多少秒。守卫/拦截器拿它写 `Retry-After` 头。 */
  readonly retryAfterSec: number
  /** 命中的是哪个维度。**只进日志，不回给客户端**——告诉攻击者他是被哪一维拦的，等于给他调参提示。 */
  readonly hitDimension: RateLimitDimension | undefined
  /** 命中的档位名，同样只进日志。 */
  readonly tier: string

  constructor(options: {
    message: string
    retryAfterSec: number
    tier: string
    hitDimension?: RateLimitDimension
  }) {
    super(options.message, HttpStatus.TOO_MANY_REQUESTS)
    this.retryAfterSec = options.retryAfterSec
    this.tier = options.tier
    this.hitDimension = options.hitDimension
  }
}

/** `Retry-After` 响应头名（RFC 9110 §10.2.3；这里用「秒数」形态，不用 HTTP 日期）。 */
export const RETRY_AFTER_HEADER = 'Retry-After'

/** 一个只需要 `setHeader` 的响应形状（不 import express 类型）。 */
export interface HeaderSettableResponse {
  setHeader(name: string, value: string | number): unknown
  headersSent?: boolean
}

/**
 * 往响应上写 `Retry-After`。
 *
 * 头已经发出去了就静默跳过——限流路径上再抛一个 `ERR_HTTP_HEADERS_SENT`
 * 会把真正的 429 掩盖成 500。
 */
export function setRetryAfter(res: HeaderSettableResponse | undefined, seconds: number): void {
  if (!res || res.headersSent) return
  res.setHeader(RETRY_AFTER_HEADER, String(Math.max(1, Math.ceil(seconds))))
}
