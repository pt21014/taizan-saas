/**
 * `NotifyChannelKind`（本包，蓝图 §4.13：`SMS | INBOX | MP_TEMPLATE | APP_PUSH`）与
 * `08-notify.prisma` 的 `NotifyChannelKind` 枚举（`SMS | EMAIL | WECHAT_OA | WECHAT_MP |
 * APP_PUSH | IN_APP`）**不是同一套命名**——两边只有 `SMS`/`APP_PUSH` 凑巧同名。
 *
 * ## 这是 T1-5 那条真实 bug 的根治面
 *
 * `notify-record.store.ts` 曾经把 `NotifyChannelKind`（TS）原样塞进 `NotifyRecord.channel`
 * 这一列：`SMS`/`APP_PUSH` 恰好蒙对了，但 `INBOX`/`MP_TEMPLATE` 在 DB 枚举里根本不存在
 * 这两个字面量，Prisma 会直接判为非法枚举值并抛错——调用方（`plan-order.service.ts` 的
 * `sendFulfilledInbox`）外面又包了一层 try/catch 兜底，于是异常被吞、日志只有一句 warn，
 * **INBOX 通道一行记录都落不进库**，表现却像是「发送成功了」。
 *
 * 本文件把这两套命名之间的转换收口成一处：`toDbNotifyChannel` 给落库用（写路径），
 * `fromDbNotifyChannel` 给 `PrismaTemplateSource` 读 `NotifyTemplate.channel` 用（读路径）——
 * 两条路径都要转，只修一条会把 bug 从「写不进去」换成「模板读出来的 channel 在
 * `NotifyService.byKind` 里找不到驱动」，一样是静默失效。
 *
 * `Record<NotifyChannelKind, ...>` 是穷尽的：`NotifyChannelKind` 以后新增一个字面量，
 * `TO_DB` 漏填这里会直接编译报错，不会等到运行时才发现。
 *
 * @packageDocumentation
 */
import type { NotifyChannelKind } from './types'

/** `08-notify.prisma` 的 `NotifyChannelKind` 枚举字面量。 */
export type DbNotifyChannelKind =
  'SMS' | 'EMAIL' | 'WECHAT_OA' | 'WECHAT_MP' | 'APP_PUSH' | 'IN_APP'

/** 本包通道 → DB 枚举。 */
const TO_DB: Record<NotifyChannelKind, DbNotifyChannelKind> = {
  SMS: 'SMS',
  INBOX: 'IN_APP',
  MP_TEMPLATE: 'WECHAT_MP',
  APP_PUSH: 'APP_PUSH',
}

/** DB 枚举 → 本包通道。`EMAIL`/`WECHAT_OA` 目前没有对应驱动，不在这张表里。 */
const FROM_DB: Partial<Record<DbNotifyChannelKind, NotifyChannelKind>> = {
  SMS: 'SMS',
  IN_APP: 'INBOX',
  WECHAT_MP: 'MP_TEMPLATE',
  APP_PUSH: 'APP_PUSH',
}

/** 落库前：本包通道 → DB 枚举字面量。 */
export function toDbNotifyChannel(channel: NotifyChannelKind): DbNotifyChannelKind {
  return TO_DB[channel]
}

/**
 * 读库后：DB 枚举字面量 → 本包通道。
 *
 * @throws DB 里出现了本包还没有驱动的通道（`EMAIL`/`WECHAT_OA`）——同步抛错，
 *   不该把一个找不到驱动的通道悄悄传给 `NotifyService`，那只会在真正发送时才炸，
 *   而且炸出来的错误信息（"通道 X 没有登记驱动"）会让人误以为是装配漏了什么。
 */
export function fromDbNotifyChannel(dbChannel: string): NotifyChannelKind {
  const channel = FROM_DB[dbChannel as DbNotifyChannelKind]
  if (!channel) {
    throw new Error(
      `[@taizan/nest-notify] 数据库通道 "${dbChannel}" 在 NotifyChannelKind 里没有对应的驱动` +
        '（目前只支持 SMS / IN_APP / WECHAT_MP / APP_PUSH）',
    )
  }
  return channel
}
