import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino'
import { currentContext } from '../context/als'
import { redactObject } from './redact'

/** {@link createPinoOptions} 的可选项。 */
export interface PinoFactoryOptions {
  /** 日志级别，默认 `info`。 */
  level?: string
  /** 是否用 pino-pretty 输出（仅开发环境；需要单独安装 pino-pretty）。 */
  pretty?: boolean
  /** 每行日志都会带上的固定字段，例如 `{ service: 'api' }`。 */
  base?: Record<string, unknown>
}

/**
 * pino 配置工厂（蓝图 §4.11）。
 *
 * 两个关键点：
 * 1. **traceId 从 {@link currentContext} 取**，用 `mixin` 挂在每一行上。
 *    老项目断的就是这一环：pino-http 自己生成了一个 reqId，业务代码里手打的日志
 *    又没有任何 id，同一次请求的两行日志在 grep 里对不上。
 * 2. **脱敏走 `formatters.log`** 而不是 pino 的 `redact` 选项，原因见 `redact.ts` 顶部注释。
 */
export function createPinoOptions(options: PinoFactoryOptions = {}): LoggerOptions {
  const { level = 'info', base, pretty = false } = options
  return {
    level,
    base: base ?? undefined,
    // 每行日志自动补 traceId / tenantId；没有上下文（启动阶段、裸脚本）时什么都不加。
    mixin: () => {
      const ctx = currentContext()
      if (!ctx) {
        return {}
      }
      return ctx.tenantId
        ? { traceId: ctx.traceId, tenantId: ctx.tenantId }
        : { traceId: ctx.traceId }
    },
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => redactObject(obj),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  }
}

/**
 * 建一个 pino 实例。
 *
 * @param options - 见 {@link PinoFactoryOptions}
 * @param destination - 输出目标；测试里传一个内存流就能断言日志内容
 */
export function createLogger(
  options: PinoFactoryOptions = {},
  destination?: DestinationStream,
): Logger {
  const opts = createPinoOptions(options)
  return destination ? pino(opts, destination) : pino(opts)
}

/**
 * pino-http 的配置。`genReqId` 从 {@link currentContext} 取 traceId，
 * 保证 HTTP 访问日志行的 `reqId` 与业务日志行的 `traceId` 是同一个值。
 *
 * 注意 pino-http 必须注册在 `ContextMiddleware` **之后**，否则 `currentContext()` 还是空的。
 */
export function createPinoHttpOptions(logger: Logger): {
  logger: Logger
  genReqId: () => string
  quietReqLogger: boolean
} {
  return {
    logger,
    genReqId: () => currentContext()?.traceId ?? '',
    quietReqLogger: true,
  }
}
