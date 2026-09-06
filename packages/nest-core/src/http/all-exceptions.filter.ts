import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
} from '@nestjs/common'
import { type ApiResponse, ErrorCode, transportErrorCode } from '@taizan/contracts'
import type { Response } from 'express'
import { currentContext } from '../context/als'
import { AppLogger } from '../logging/logger.service'
import { BizException } from './biz.exception'

/**
 * 把传输层 HTTP 状态码组装成 7 位错误码：域段 `10`（通用）+ 状态码 + 序号 `00`。
 *
 * 例：`404` → `1040400`、`401` → `1040100`。这些码**不进 `ErrorCode` 内置表**，
 * 按规则现算——覆盖的状态码有几十个，逐个登记只会得到一张永远不全的表。
 *
 * 真源是 `@taizan/contracts` 的同名函数，这里只做转出，让 `@taizan/nest-core` 的
 * 使用者不必为了一个纯函数再 import 一次 contracts。
 */
export { transportErrorCode }

/**
 * 全局异常过滤器（蓝图 §4.9）。
 *
 * 三条分支：
 * 1. `BizException` → HTTP **200** + 业务码；
 * 2. `HttpException`（以及 body-parser 那种带 `status` 字段的类 HTTP 错误）→ 原状态码 + 信封；
 * 3. 其余未知异常 → 500 + `9050000`，**生产环境不回传堆栈也不回传原始 message**，
 *    只在日志里记全。原始 message 里经常带着连接串、SQL 片段、内部路径。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
    @Optional() @Inject('TAIZAN_IS_PRODUCTION') private readonly isProductionFlag?: boolean,
  ) {}

  private get isProduction(): boolean {
    return this.isProductionFlag ?? process.env.NODE_ENV === 'production'
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception
    }
    const res = host.switchToHttp().getResponse<Response>()

    // 响应头可能还没被 ContextMiddleware 写上（异常发生在它之前），补一次。
    const traceId = currentContext()?.traceId
    if (traceId && !res.headersSent) {
      res.setHeader('X-Trace-Id', traceId)
    }

    if (exception instanceof BizException) {
      this.logger?.debug?.(`业务异常 ${exception.code}：${exception.message}`, 'Exception')
      this.send(res, HttpStatus.OK, {
        code: exception.code,
        message: exception.message,
        data: exception.data ?? null,
      })
      return
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      this.logger?.warn?.(`传输层异常 ${status}：${exception.message}`, 'Exception')
      this.send(res, status, {
        code: transportErrorCode(status),
        message: extractHttpExceptionMessage(exception),
        data: null,
      })
      return
    }

    // body-parser / multer 这类错误不是 HttpException，但带着 status。
    // 不认它就会掉进下面的 500「系统内部错误」——而它其实是请求本身的问题，
    // 商家看到「系统内部错误」只会原样重试，重试一次就是再传一次同样超大的东西。
    const transport = httpishClientStatus(exception)
    if (transport !== null) {
      this.logger?.warn?.(
        `传输层拒绝 ${transport}：${exception instanceof Error ? exception.message : String(exception)}`,
        'Exception',
      )
      this.send(res, transport, {
        code: transportErrorCode(transport),
        message: explainTransport(transport),
        data: null,
      })
      return
    }

    // 未知异常：日志记全（含堆栈），响应只给一句固定文案。
    this.logger?.error?.(
      exception instanceof Error ? exception.message : String(exception),
      exception instanceof Error ? exception.stack : undefined,
      'Exception',
    )
    this.send(res, HttpStatus.INTERNAL_SERVER_ERROR, {
      code: ErrorCode.INTERNAL_ERROR.code,
      message: this.isProduction
        ? ErrorCode.INTERNAL_ERROR.message
        : `${ErrorCode.INTERNAL_ERROR.message}：${
            exception instanceof Error ? exception.message : String(exception)
          }`,
      data: null,
    })
  }

  private send(res: Response, status: number, body: ApiResponse): void {
    if (res.headersSent) {
      // 流式响应写到一半炸了，只能断掉连接——再 json() 会抛 ERR_HTTP_HEADERS_SENT，
      // 把真正的异常掩盖掉。
      res.end()
      return
    }
    res.status(status).json(body)
  }
}

/** 从 `HttpException` 的 response body 里抠出人话（Nest 的 ValidationPipe 会塞 string[]）。 */
function extractHttpExceptionMessage(exception: HttpException): string {
  const body: unknown = exception.getResponse()
  if (typeof body === 'string') {
    return body
  }
  if (body !== null && typeof body === 'object' && 'message' in body) {
    const message: unknown = (body as { message?: unknown }).message
    if (Array.isArray(message)) {
      return message.map((m) => String(m)).join('; ')
    }
    if (typeof message === 'string') {
      return message
    }
  }
  return exception.message
}

/**
 * 这个异常是不是「请求本身有问题」。
 *
 * **只认 4xx**：带 status 的 5xx 照旧走未知异常分支（要打完整堆栈，那是我们的锅）。
 * express 系的错误对象把状态码放在 `status` 或 `statusCode` 上，两个都要看——
 * 只看一个的话，另一半错误仍然会被报成「系统内部错误」。
 */
function httpishClientStatus(e: unknown): number | null {
  if (e === null || typeof e !== 'object') {
    return null
  }
  const raw = e as { status?: unknown; statusCode?: unknown }
  const status = Number(raw.status ?? raw.statusCode)
  return Number.isInteger(status) && status >= 400 && status < 500 ? status : null
}

/**
 * 说人话。**尤其是 413**：默认那句 `request entity too large` 对商家毫无意义，
 * 而这一条几乎只有一个成因——正文里有直接粘贴进来的图片。
 *
 * 其余一律回固定文案，**不把原始 message 透出去**：这条分支认的是「任何带 4xx status 的对象」，
 * 哪天某个库把内部路径或上游返回放进 message，它就顺着这条路原样发到公网上，而没有任何东西会提醒我们。
 * 真要排查，日志里那行 warn 有完整原文。
 */
function explainTransport(status: number): string {
  if (status === 413) {
    return '内容太大，保存不了。多半是正文里有直接粘贴进来的图片——请重新打开编辑器让它把图转存到素材库后再保存'
  }
  if (status === 415) {
    return '这种格式的内容我们收不了，请检查请求头 Content-Type'
  }
  if (status === 400) {
    return '请求格式不对（多半是 JSON 写坏了）'
  }
  return '请求有误'
}
