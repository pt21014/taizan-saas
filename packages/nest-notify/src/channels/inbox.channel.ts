/**
 * 站内信通道。
 *
 * 站内信没有外部传输——"发送"这个动作本身就是把 `NotifyRecord`/
 * `PlatformNotifyRecord` 那一行写进库（有 `tenantId` 走 `tenant` 句柄，平台通知
 * 走 `raw`，见 `notify-record.store.ts` 里 `// raw-reason: ...` 那一处）。
 * `NotifyService.send()` 对**每个通道**都会在调用完 driver 之后写这条记录
 * （落 `NotifyRecord` 是所有通道共用的"结果台账"，不只是 INBOX 才有），
 * 所以 INBOX 驱动本身不用再写一遍库——它只需要证明"这个通道总是能送达"，
 * 直接返回成功即可，真正落库发生在 `NotifyService` 那一次共用调用里。
 *
 * 换句话说：**INBOX 的"发送"= `NotifyService` 随后要做的那次写库**，这里的
 * `send()` 是一个恒成功的占位，不是"没实现"。
 */
import type { NotifyChannelDriver, NotifyMessage, NotifyResult } from '../types'

export function createInboxChannel(): NotifyChannelDriver {
  return {
    kind: 'INBOX',
    async send(message: NotifyMessage): Promise<NotifyResult> {
      if (!message.to.userId) {
        return { ok: false, channel: 'INBOX', error: '缺少接收用户（NotifyTarget.userId）' }
      }
      return { ok: true, channel: 'INBOX' }
    },
  }
}
