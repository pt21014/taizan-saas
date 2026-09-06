/**
 * 租户隔离层的唯一错误类型。
 *
 * 这里刻意不用「多个 Error 子类」而用一个类 + `reason` 枚举：调用方（Nest 的
 * ExceptionFilter、执行层扩展、CI 脚本）需要按原因分流，而 `instanceof` 链在跨包
 * 打包（ESM/CJS 双产物 + 可能的多份副本）后并不可靠，字符串 reason 永远可靠。
 */

/**
 * 隔离决策失败的原因枚举。
 *
 * - `NO_CONTEXT`：在租户域模型上执行操作，但没有当前租户上下文。**失败关闭**，
 *   绝不退化成「查全表」。
 * - `UNKNOWN_OPERATION`：租户域模型上出现了决策函数不认识的 Prisma 操作。
 *   **失败关闭**：Prisma 升级引入新操作时必须显式声明隔离方式，而不是放行。
 * - `FOREIGN_RESULT`：按唯一键读到 / 定位到的记录属于别的租户。
 * - `MODEL_NOT_REGISTERED`：模型没有登记进租户模型注册表（仅在
 *   `onUnregistered: 'throw'` 模式下抛出）。
 * - `TENANT_ID_CONFLICT`：调用方在 `data` / `create` / `update` 里显式写了另一个
 *   租户的 `tenantId`，或用关系写（`tenant: { connect }`）绕过标量注入。
 * - `REGISTRY_FROZEN`：注册表冻结后仍试图 `register`（启动期之后不允许再改）。
 * - `DUPLICATE_REGISTRATION`：同一个模型被登记了两次，通常意味着两处清单打架。
 * - `INVALID_MODEL_NAME`：模型名为空串或非字符串。
 * - `INVALID_ARGUMENT`：传给决策函数 / 校验器的参数形状不合法。
 */
export type TenantScopeErrorReason =
  | 'NO_CONTEXT'
  | 'UNKNOWN_OPERATION'
  | 'FOREIGN_RESULT'
  | 'MODEL_NOT_REGISTERED'
  | 'TENANT_ID_CONFLICT'
  | 'REGISTRY_FROZEN'
  | 'DUPLICATE_REGISTRATION'
  | 'INVALID_MODEL_NAME'
  | 'INVALID_ARGUMENT'

/** 构造 {@link TenantScopeError} 时可以附带的定位信息，用于日志与错误提示。 */
export interface TenantScopeErrorContext {
  /** Prisma 模型名，例如 `Goods`。 */
  model?: string
  /** Prisma 操作名，例如 `findMany`。 */
  operation?: string
  /** 当前租户 id（不含任何用户数据，可安全进日志）。 */
  tenantId?: string
}

/**
 * 租户隔离层抛出的错误。
 *
 * @example
 * ```ts
 * try {
 *   planTenantScope({ model: 'Goods', operation: 'findMany', args: {}, tenantId: '', registered })
 * } catch (e) {
 *   if (isTenantScopeError(e, 'NO_CONTEXT')) {
 *     // 没有租户上下文：这是编码错误，不是用户错误
 *   }
 * }
 * ```
 */
export class TenantScopeError extends Error {
  /** 失败原因，调用方按它分流，不要去 match message 文本。 */
  readonly reason: TenantScopeErrorReason
  /** 出问题的 Prisma 模型名（如果适用）。 */
  readonly model: string | undefined
  /** 出问题的 Prisma 操作名（如果适用）。 */
  readonly operation: string | undefined
  /** 当时的租户 id（如果适用）。 */
  readonly tenantId: string | undefined

  /**
   * @param reason - 失败原因枚举
   * @param message - 面向开发者的中文说明，要指明「去哪里补」
   * @param context - 可选的模型 / 操作 / 租户定位信息
   */
  constructor(
    reason: TenantScopeErrorReason,
    message: string,
    context: TenantScopeErrorContext = {},
  ) {
    super(message)
    this.name = 'TenantScopeError'
    this.reason = reason
    this.model = context.model
    this.operation = context.operation
    this.tenantId = context.tenantId
  }
}

/**
 * 判断一个未知异常是否为 {@link TenantScopeError}，可选地再判断具体原因。
 *
 * 用鸭子类型而不是 `instanceof`：同一个包在 monorepo 里可能被打成 ESM + CJS 两份，
 * `instanceof` 会漏判，而漏判在这里等于「把隔离错误当成普通错误吞掉」。
 *
 * @param error - 任意捕获到的异常
 * @param reason - 可选，进一步限定原因
 * @returns 是否为该原因的租户隔离错误
 */
export function isTenantScopeError(
  error: unknown,
  reason?: TenantScopeErrorReason,
): error is TenantScopeError {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; reason?: unknown }
  if (candidate.name !== 'TenantScopeError') return false
  if (typeof candidate.reason !== 'string') return false
  return reason === undefined ? true : candidate.reason === reason
}
