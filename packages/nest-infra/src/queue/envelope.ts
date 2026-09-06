/**
 * `JobEnvelope`：入队时套在业务 payload 外面的信封（蓝图 §4.7）。
 *
 * 为什么不直接把业务 payload 丢进队列：worker 里没有 HTTP 请求，也就没有租户上下文和
 * traceId。不随消息一起带过去的话，job 的日志既不知道自己属于哪家店，也串不回触发它的
 * 那个请求——线上排查时手里只剩一条「发短信失败」，没有任何上文。
 *
 * ## 字段为什么叫 `originTenantId` 而不是 `tenantId`
 *
 * 与 `07-infra.prisma` 里那四张平台域表同一个理由：这些数据的读者是无人值守的后台进程，
 * 它们没有租户上下文；叫 `tenantId` 会被租户隔离校验器当成归属列，而蓝图 §3.1 又禁止
 * 可空 `tenantId`。信封与 `JobDeadLetter.originTenantId` 用同一个名字，落死信时可以直接对拷。
 *
 * @packageDocumentation
 */

/** 队列消息信封。 */
export interface JobEnvelope<T = unknown> {
  /**
   * 任务来自哪家店；平台级任务为 `undefined`。
   *
   * worker 会用它 `runWithContext({ tenantId })`，所以业务处理器里照常能用
   * `prisma.tenant`——租户隔离在队列里也是生效的。
   */
  originTenantId?: string
  /**
   * **入队方**的 traceId。
   *
   * 注意方向：这里存的不是 worker 执行时的 traceId，而是「谁把这条消息放进来的」。
   * worker 执行时会开一个**新** traceId，并把这个值放进 `parentTraceId`。
   */
  traceId: string
  /** 入队方自己的上游 traceId（入队方本身也可能是个 job）。用于串多级链路。 */
  parentTraceId?: string
  /** 业务 payload。 */
  data: T
  /** 入队时刻（epoch ms）。死信里用来算「积压了多久」。 */
  enqueuedAt: number
}

/** 运行期判断一个值是不是信封（从 Redis 反序列化回来的东西没有类型）。 */
export function isJobEnvelope(value: unknown): value is JobEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v['traceId'] === 'string' && 'data' in v
}
