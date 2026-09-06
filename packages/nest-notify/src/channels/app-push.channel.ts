/** App 推送通道：本阶段是 `NoopChannel`，见 `noop.channel.ts` 的文件头。 */
import type { NotifyChannelDriver } from '../types'
import { createNoopChannel } from './noop.channel'

export function createAppPushChannel(): NotifyChannelDriver {
  return createNoopChannel('APP_PUSH')
}
