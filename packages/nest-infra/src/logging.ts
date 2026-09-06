/**
 * 本包的日志出口。
 *
 * 为什么不直接 `@Inject(AppLogger)`：`AppLogger` 要求 `PINO_LOGGER` 也在容器里，
 * 而单测里起一个最小 Nest 应用时并不想把 pino 一起装上。所以这里只约定一个结构，
 * 默认实现是 Nest 自带的 `Logger`，业务侧在 `InfraModule.forRoot({ logger })`
 * 里把 `AppLogger` 传进来即可（`AppLogger` 天然满足这个结构）。
 *
 * @packageDocumentation
 */

/** 日志器的最小结构（`AppLogger` 与 Nest 的 `Logger` 都满足）。 */
export interface InfraLogger {
  log(message: unknown, context?: string): void
  warn(message: unknown, context?: string): void
  error(message: unknown, stack?: string, context?: string): void
  debug?(message: unknown, context?: string): void
}
