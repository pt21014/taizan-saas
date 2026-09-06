import { Inject, Injectable, type LoggerService, Optional } from '@nestjs/common'
import type { Logger as PinoLogger } from 'pino'

/** 底层 pino 实例的注入 token。 */
export const PINO_LOGGER = Symbol.for('@taizan/nest-core:PINO_LOGGER')

/**
 * 可注入的应用日志器，同时实现 Nest 的 `LoggerService`——
 * 所以既能 `constructor(@Inject(AppLogger) logger)` 用，也能
 * `app.useLogger(app.get(AppLogger))` 接管 Nest 自己的启动日志，两边输出到同一个 pino 实例。
 *
 * traceId 不需要手动传：{@link createPinoOptions} 的 `mixin` 会从 AsyncLocalStorage 里取。
 */
@Injectable()
export class AppLogger implements LoggerService {
  constructor(@Inject(PINO_LOGGER) private readonly pino: PinoLogger) {}

  /** 底层 pino 实例，需要 `child()` 或结构化字段时用。 */
  get raw(): PinoLogger {
    return this.pino
  }

  /** 建一个带固定字段的子日志器，例如 `logger.child({ module: 'payment' })`。 */
  child(bindings: Record<string, unknown>): PinoLogger {
    return this.pino.child(bindings)
  }

  log(message: unknown, context?: string): void {
    this.pino.info(bind(context), stringify(message))
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.pino.error({ ...bind(context), stack }, stringify(message))
  }

  warn(message: unknown, context?: string): void {
    this.pino.warn(bind(context), stringify(message))
  }

  debug(message: unknown, context?: string): void {
    this.pino.debug(bind(context), stringify(message))
  }

  verbose(message: unknown, context?: string): void {
    this.pino.trace(bind(context), stringify(message))
  }

  fatal(message: unknown, context?: string): void {
    this.pino.fatal(bind(context), stringify(message))
  }
}

function bind(context?: string): Record<string, unknown> {
  return context ? { context } : {}
}

function stringify(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message)
}

/**
 * 一个什么都不做的 {@link AppLogger}，给单测用——测业务逻辑时不想让日志刷屏。
 */
@Injectable()
export class NoopAppLogger extends AppLogger {
  constructor(@Optional() @Inject(PINO_LOGGER) pino?: PinoLogger) {
    super(pino ?? ({} as PinoLogger))
  }
  override log(): void {}
  override error(): void {}
  override warn(): void {}
  override debug(): void {}
  override verbose(): void {}
  override fatal(): void {}
}
