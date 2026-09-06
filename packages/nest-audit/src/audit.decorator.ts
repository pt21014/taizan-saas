/**
 * `@Audit()` 方法装饰器（蓝图 §4.8）。
 *
 * 只挂元数据，不做任何逻辑——真正的记录逻辑在 `AuditInterceptor` 里读这份元数据执行。
 * 拆开是为了装饰器本身保持零依赖（不需要在装饰的位置就能拿到 `Reflector`）。
 *
 * @packageDocumentation
 */

import { SetMetadata } from '@nestjs/common'
import type { Request } from 'express'

/** `Reflector.getAllAndOverride` 用的元数据 key。 */
export const AUDIT_METADATA_KEY = Symbol.for('@taizan/nest-audit:AUDIT_METADATA_KEY')

/** `@Audit()` 的选项。 */
export interface AuditOptions {
  /** 动作码，建议来自 `defineAuditActions()` 定义的常量。 */
  action: string
  /** 被操作对象的类型名，自由文本，例如 `'Goods'`。 */
  targetType?: string
  /** 从请求里取被操作对象的 id，例如 `(req) => req.params.id`。取不到就返回 `undefined`。 */
  targetId?: (req: Request) => string | undefined
  /**
   * 是否用 `AuditSnapshot.snapshotForAudit(targetId)` 在处理器执行前后各拍一张快照，
   * 分别落进 `before` / `after`。
   *
   * 打开后**不会**再把请求体存进 `after`——两者二选一，见 `audit.interceptor.ts` 的
   * `resolveAfter()`。要同时留痕请求体，在 controller 的 `snapshotForAudit()` 实现里
   * 自己把它拼进返回值。
   *
   * 默认 `false`。
   */
  captureBefore?: boolean
  /**
   * `captureBefore` 未开启时，是否把请求体脱敏（复用 `@taizan/nest-core` 的
   * `redactObject`）后存进 `after`。默认 `true`；只有明确知道这个路由的请求体
   * 不含敏感字段时才该关掉。
   */
  redactBody?: boolean
}

/**
 * 标记一个控制器方法需要自动审计。
 *
 * @example
 * ```ts
 * @Audit({ action: AUDIT_ACTIONS.STAFF_REMOVE, targetType: 'Staff', targetId: (req) => req.params.id })
 * @Delete(':id')
 * remove(@Param('id') id: string) { ... }
 * ```
 */
export function Audit(options: AuditOptions): MethodDecorator {
  return SetMetadata(AUDIT_METADATA_KEY, options)
}
