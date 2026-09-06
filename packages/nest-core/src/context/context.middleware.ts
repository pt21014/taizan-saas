import { Inject, Injectable, Optional, type NestMiddleware } from '@nestjs/common'
import { isUlid, ulid } from '@taizan/contracts'
import type { NextFunction, Request, Response } from 'express'
import { runWithContext } from './als'
import { IP_RESOLVER, PLACEHOLDER_IP_RESOLVER, readIpSource, type IpResolver } from './ip-resolver'
import type { RequestContext } from './request-context'

/** 入站/回写用的 traceId 请求头名。 */
export const TRACE_ID_HEADER = 'x-trace-id'

/**
 * 从入站请求头里取 traceId，**必须校验格式**。
 *
 * 不校验的话，任何人都能往日志里注入换行、超长字符串或伪造别人的 traceId
 * （traceId 会进审计记录，被人挑同一个值刷一遍，排查时就分不清哪条是谁的）。
 * 格式不合法就当作没传，重新生成一个——丢一次链路关联，好过让日志被污染。
 */
export function resolveInboundTraceId(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return isUlid(trimmed) ? trimmed.toUpperCase() : undefined
}

/**
 * 每请求上下文中间件（蓝图 §4.1、§4.11）。
 *
 * 职责只有四件：生成/接续 traceId、把 traceId 回写响应头、填 `ctx.ip`（委托给可注入的
 * {@link IP_RESOLVER}，见 `ip-resolver.ts` 的文件头）、把整条请求处理链
 * 放进 {@link runWithContext} 里跑。租户解析、身份认证都不在这里——
 * 它们是守卫/后续中间件的事，只需要 `patchCurrentContext` 往这个 ctx 上补字段。
 *
 * 注册顺序必须是**最外层**：任何在它之前执行的中间件都拿不到上下文，日志也就没有 traceId。
 */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  /**
   * @param ipResolver - IP 解析器。`@Optional()`：只装 `CoreModule` 的最小进程里没人提供它，
   *   此时退回 {@link PLACEHOLDER_IP_RESOLVER}（粒度粗但不可伪造）。
   *   装了 `AuthModule.forRoot` 的进程会注入 `resolveIps` 的适配器，
   *   那才是不变量 6 说的那个真源
   */
  constructor(
    @Optional()
    @Inject(IP_RESOLVER)
    private readonly ipResolver: IpResolver = PLACEHOLDER_IP_RESOLVER,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = resolveInboundTraceId(req.headers[TRACE_ID_HEADER])
    const traceId = inbound ?? ulid()

    // 回写响应头：前端报错截图里带上它，客服转到研发就能一把捞到全部日志。
    res.setHeader('X-Trace-Id', traceId)

    const ctx: RequestContext = {
      traceId,
      ip: this.ipResolver.resolve(readIpSource(req)),
      startedAt: Date.now(),
    }

    runWithContext(ctx, () => {
      next()
    })
  }
}
