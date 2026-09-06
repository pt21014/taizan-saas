/**
 * 日志器契约。
 *
 * 与 `@taizan/nest-infra` 的 `InfraLogger` 同形：本包不 import 那个类型，
 * 是为了让「只想用回调控制器、不想装整套基础设施」的调用方也能编译过。
 * 生产传 `@taizan/nest-core` 的 `AppLogger`，不传就退化成 Nest 自带的 `Logger`。
 *
 * @packageDocumentation
 */

/** 最小日志器。 */
export interface PaymentLogger {
  log(message: unknown, context?: string): void
  warn(message: unknown, context?: string): void
  error(message: unknown, stack?: string, context?: string): void
  debug?(message: unknown, context?: string): void
}
