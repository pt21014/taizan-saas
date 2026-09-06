import { AsyncLocalStorage } from 'node:async_hooks'
import type { RequestContext } from './request-context'

/**
 * 进程内唯一的上下文存储。
 *
 * 导出它是为了让极少数需要手动 `enterWith` 的场景（比如某些第三方中间件的回调里）能够接上，
 * 常规代码请只用 {@link runWithContext} / {@link currentContext}。
 */
export const contextStorage = new AsyncLocalStorage<RequestContext>()

/**
 * 在给定上下文中执行 `fn`。`fn` 内部（包括它 await 出去的所有异步分支）
 * 都能通过 {@link currentContext} 拿到这个 ctx。
 *
 * 返回值直接透传 `fn` 的返回值（同步返回同步值，返回 Promise 就返回 Promise），
 * 不强行包一层 Promise——中间件里要的是同步调用 `next()`。
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return contextStorage.run(ctx, fn)
}

/** 取当前上下文；不在任何上下文中（比如进程启动阶段）返回 `undefined`。 */
export function currentContext(): RequestContext | undefined {
  return contextStorage.getStore()
}

/**
 * 在当前上下文之上覆盖若干字段，并在新上下文中执行 `fn`。
 *
 * 典型用法：守卫认证成功后补 `identity` 与 `tenantId`。
 * 直接改 `currentContext()` 返回的对象也能生效（它是同一个引用），
 * 但那样就没法在测试里断言「谁在什么时候改了什么」，所以提供这个显式入口。
 */
export function runWithPatchedContext<T>(patch: Partial<RequestContext>, fn: () => T): T {
  const base = currentContext()
  if (!base) {
    throw new MissingRequestContextError('runWithPatchedContext 要求已经处于某个请求上下文中')
  }
  return runWithContext({ ...base, ...patch }, fn)
}

/**
 * 就地修改当前上下文。守卫/中间件在认证完成后补 `identity`、`tenantId` 用这个——
 * 它们没法把后续整条链包进一个新的 `run()` 里。
 */
export function patchCurrentContext(patch: Partial<RequestContext>): void {
  const ctx = currentContext()
  if (!ctx) {
    throw new MissingRequestContextError('patchCurrentContext 要求已经处于某个请求上下文中')
  }
  Object.assign(ctx, patch)
}

/** 完全没有请求上下文时抛出（例如在裸脚本里调了要求上下文的代码）。 */
export class MissingRequestContextError extends Error {
  override readonly name = 'MissingRequestContextError'
  constructor(
    message = '当前不在任何请求上下文中（是否漏了 ContextMiddleware / runWithContext？）',
  ) {
    super(message)
  }
}

/**
 * 有上下文但没有 `tenantId` 时抛出。
 *
 * 刻意和 `@taizan/tenant-scope` 的 `TenantScopeError` 分开：那个是「查询计划算不出隔离条件」，
 * 这个是「压根没解析出租户」，排查方向完全不同。nest-core 不依赖 tenant-scope，
 * 所以也不能复用它的错误类型。
 */
export class TenantContextMissingError extends Error {
  override readonly name = 'TenantContextMissingError'
  constructor(message = '当前上下文没有 tenantId（该路由是否漏挂租户解析中间件？）') {
    super(message)
  }
}

/**
 * 取当前租户 id，取不到就抛。
 *
 * **失败关闭**：宁可 500 也绝不返回 undefined 让调用方「查全部租户」——
 * 后者是跨租户数据泄漏，而前者只是一次报错。
 *
 * @throws {MissingRequestContextError} 完全没有上下文
 * @throws {TenantContextMissingError} 有上下文但没有租户
 */
export function requireTenantId(): string {
  const ctx = currentContext()
  if (!ctx) {
    throw new MissingRequestContextError()
  }
  if (!ctx.tenantId) {
    throw new TenantContextMissingError()
  }
  return ctx.tenantId
}

/** 取当前 traceId；没有上下文时返回 `undefined`。 */
export function currentTraceId(): string | undefined {
  return currentContext()?.traceId
}
