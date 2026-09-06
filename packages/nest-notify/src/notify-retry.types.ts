import type { NotifyChannelKind, NotifyMessage } from './types'

/** `notify.retry` 队列的任务名，`QueueService.add` 与 `@JobHandler({ name })` 都用它。 */
export const NOTIFY_RETRY_JOB = 'notify.retry'

/** `notify.retry` 的任务载荷：重试的单位是"一次通道尝试"，不是整个 `NotifySendRequest`。 */
export interface NotifyRetryPayload {
  tenantId?: string
  channel: NotifyChannelKind
  message: NotifyMessage
  /** 要更新状态的那条 `NotifyRecord`/`PlatformNotifyRecord` 的 id。 */
  recordId: string
}
