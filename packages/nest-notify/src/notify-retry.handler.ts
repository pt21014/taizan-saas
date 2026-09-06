/**
 * `NotifyRetryHandler`：`notify.retry` 队列的处理器。
 *
 * **重试与死信全部交给 `@taizan/nest-infra`**：`@JobHandler` 声明
 * `attempts: 3` + 指数退避（与 `JOB_DEFAULTS` 一致，这里显式写出只是为了让
 * 读代码的人不用去翻默认值），本处理器只负责"再发一次、更新记录"——
 * **发送失败必须 throw**，`JobProcessor.process` 的契约是"抛异常=这次尝试失败，
 * 队列按退避重试；不抛=成功"，`ProcessorFactory`/`MemoryQueueDriver` 都是按这个
 * 契约驱动重试计数与死信落库的，本处理器自己数第几次反而会跟队列的计数对不上。
 *
 * @packageDocumentation
 */
import { Inject, Injectable } from '@nestjs/common'
import { JobHandler, type JobEnvelope, type JobProcessor } from '@taizan/nest-infra'
import { PrismaService } from '@taizan/nest-prisma'
import { updateNotifyRecordStatus } from './notify-record.store'
import { NOTIFY_CHANNELS } from './tokens'
import { NOTIFY_RETRY_JOB, type NotifyRetryPayload } from './notify-retry.types'
import type { NotifyChannelDriver, NotifyChannelKind } from './types'

@Injectable()
@JobHandler({
  name: NOTIFY_RETRY_JOB,
  attempts: 3,
  backoff: { type: 'exponential', delayMs: 2000 },
  deadLetter: true,
})
export class NotifyRetryHandler implements JobProcessor<NotifyRetryPayload> {
  private readonly byKind: Map<NotifyChannelKind, NotifyChannelDriver>

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NOTIFY_CHANNELS) channels: NotifyChannelDriver[],
  ) {
    this.byKind = new Map(channels.map((c) => [c.kind, c]))
  }

  async process(envelope: JobEnvelope<NotifyRetryPayload>): Promise<void> {
    const { tenantId, channel, message, recordId } = envelope.data
    const driver = this.byKind.get(channel)
    if (!driver) {
      throw new Error(`[@taizan/nest-notify] 重试时找不到通道 "${channel}" 的驱动`)
    }

    const result = await driver.send(message)
    await updateNotifyRecordStatus(this.prisma, recordId, tenantId, result)

    if (!result.ok) {
      throw new Error(result.error ?? `[@taizan/nest-notify] 通道 "${channel}" 重试仍然失败`)
    }
  }
}
