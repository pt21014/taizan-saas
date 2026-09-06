/**
 * 后台执行（cron tick / 队列 job）的上下文注入（蓝图 §4.11）。
 *
 * > 队列 job、cron tick 各开新 traceId 并记 `parentTraceId`
 * > ——队列与 cron 的 traceId 注入是最常被漏的一处。
 *
 * 漏了会怎样：job 里的所有日志没有 traceId，出问题时你手上只有一条「发短信失败」，
 * 却回答不了「是哪个请求触发的」。而如果图省事直接**复用**入队时的 traceId，
 * 一个 traceId 会横跨请求与它派生出来的十几个 job，链路又变成一团。
 * 所以是「新 traceId + parentTraceId 指回去」这一种写法。
 *
 * @packageDocumentation
 */

import { runWithContext, type RequestContext } from '@taizan/nest-core'
import { ulid } from '@taizan/contracts'

/**
 * 后台执行没有真实客户端 IP。
 *
 * 不写 `127.0.0.1`：那是个**看起来合法**的 IP，会混进限流统计和审计记录里，
 * 排查时让人以为真有人从本机发了请求。用一个明显非 IP 的字面量，一眼就知道是后台。
 */
export const BACKGROUND_IP = '-'

/** {@link runInFreshContext} 的入参。 */
export interface FreshContextInit {
  /** 上游 traceId（入队时的 / 触发 cron 的那个请求的）。cron tick 没有上游，传 `undefined`。 */
  parentTraceId?: string
  /** 这次执行归属的租户。平台级任务为 `undefined`。 */
  tenantId?: string
  /** 显式指定 traceId（几乎只在测试里用）。 */
  traceId?: string
}

/**
 * 开一个全新的执行上下文跑 `fn`。
 *
 * @returns `fn` 的返回值，外加这次用的 traceId（调用方要落库时用）
 */
export function runInFreshContext<T>(
  init: FreshContextInit,
  fn: (traceId: string) => Promise<T>,
): Promise<T> {
  const traceId = init.traceId ?? ulid()
  const ctx: RequestContext = {
    traceId,
    parentTraceId: init.parentTraceId,
    tenantId: init.tenantId,
    ip: { client: BACKGROUND_IP, edge: BACKGROUND_IP },
    startedAt: Date.now(),
  }
  return runWithContext(ctx, () => fn(traceId))
}
