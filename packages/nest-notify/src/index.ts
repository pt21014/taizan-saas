/**
 * `@taizan/nest-notify`：通知抽象（蓝图 §4.13）——短信 / 站内信 / 公众号模板消息 /
 * App 推送四通道，模板化、失败进队列重试（3 次指数退避，交给 `@taizan/nest-infra`）、
 * 仍失败进死信，`fallback: true` 时按 `channels` 顺序降级。
 *
 * @packageDocumentation
 */
export type {
  NotifyChannelDriver,
  NotifyChannelKind,
  NotifyMessage,
  NotifyResult,
  NotifySendRequest,
  NotifyTarget,
} from './types'
export type { NotifyService as NotifyServiceContract } from './types'

export { renderTemplate } from './render'
export { fromDbNotifyChannel, toDbNotifyChannel, type DbNotifyChannelKind } from './channel-map'
export {
  InMemoryTemplateSource,
  PrismaTemplateSource,
  type NotifyTemplateDef,
  type NotifyTemplateSource,
} from './template-source'
export {
  updateNotifyRecordStatus,
  writeNotifyRecord,
  type NotifyPrisma,
  type NotifyRecordStatus,
} from './notify-record.store'

export { createSmsChannel, type SmsChannelOptions } from './channels/sms.channel'
export { createInboxChannel } from './channels/inbox.channel'
export { createMpTemplateChannel } from './channels/mp-template.channel'
export { createAppPushChannel } from './channels/app-push.channel'
export { createNoopChannel } from './channels/noop.channel'

export { NOTIFY_CHANNELS, NOTIFY_TEMPLATE_SOURCE } from './tokens'
export { NOTIFY_RETRY_JOB, type NotifyRetryPayload } from './notify-retry.types'
export { NotifyRetryHandler } from './notify-retry.handler'
export { NotifyService } from './notify.service'
export { NotifyModule, type NotifyModuleOptions } from './notify.module'
