/**
 * 本包自己的错误类型。
 *
 * 租户隔离相关的错误**不在这里**——它们由 `@taizan/tenant-scope` 的 `TenantScopeError`
 * 统一定义，执行层原样往上抛，用 `isTenantScopeError()` 判别。执行层再造一套隔离错误
 * 只会让上层要 catch 两种类型，早晚漏一种。
 *
 * @packageDocumentation
 */

/** {@link OptimisticLockError} 的上下文，便于日志与排查。 */
export interface OptimisticLockErrorContext {
  /** Prisma 模型名。 */
  model: string
  /** 调用方期望的版本号。 */
  expectedVersion: number
}

/**
 * 乐观锁冲突：按 `version = expectedVersion` 更新时命中 0 行。
 *
 * 两种情况都会落到这里，且**故意不区分**：记录已被别人改过（version 变了），
 * 或者记录压根不存在 / 不属于当前租户（被隔离条件挡掉）。区分它们需要再查一次库，
 * 而那次查询本身又会有竞态；对调用方来说两种情况的处理都是「重读后重试」。
 */
export class OptimisticLockError extends Error {
  override readonly name = 'OptimisticLockError'

  /** 冲突发生在哪个模型、期望的是哪个版本。 */
  readonly context: OptimisticLockErrorContext

  constructor(context: OptimisticLockErrorContext, message?: string) {
    super(
      message ??
        `${context.model} 的乐观锁更新失败：期望 version=${context.expectedVersion} 的记录没有命中` +
          `（已被并发修改，或不存在 / 不属于当前租户）。请重新读取后重试。`,
    )
    this.context = context
  }
}

/** 类型守卫：判断一个 unknown 是不是 {@link OptimisticLockError}。 */
export function isOptimisticLockError(error: unknown): error is OptimisticLockError {
  return error instanceof OptimisticLockError
}
