/**
 * `NotifyService`：通知发送的唯一入口（蓝图 §4.13）。
 *
 * 流程：渲染模板 → 逐通道发送 → 每个通道的结果落 `NotifyRecord`/
 * `PlatformNotifyRecord` → 失败的进 `notify.retry` 队列（重试/死信交给
 * `@taizan/nest-infra`，本服务不自己数"第几次"）。
 *
 * @packageDocumentation
 */
import { Inject, Injectable } from '@nestjs/common'
import { currentContext } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'
import { QueueService } from '@taizan/nest-infra'
import { ulid } from '@taizan/contracts'
import { renderTemplate } from './render'
import { writeNotifyRecord } from './notify-record.store'
import { NOTIFY_CHANNELS, NOTIFY_TEMPLATE_SOURCE } from './tokens'
import type { NotifyTemplateSource } from './template-source'
import type {
  NotifyChannelDriver,
  NotifyChannelKind,
  NotifyMessage,
  NotifyResult,
  NotifySendRequest,
} from './types'
import { NOTIFY_RETRY_JOB, type NotifyRetryPayload } from './notify-retry.types'

@Injectable()
export class NotifyService {
  private readonly byKind: Map<NotifyChannelKind, NotifyChannelDriver>

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(NOTIFY_CHANNELS) channels: NotifyChannelDriver[],
    @Inject(NOTIFY_TEMPLATE_SOURCE) private readonly templates: NotifyTemplateSource,
  ) {
    this.byKind = new Map(channels.map((c) => [c.kind, c]))
  }

  private resolveDriver(kind: NotifyChannelKind): NotifyChannelDriver {
    const driver = this.byKind.get(kind)
    if (!driver) {
      throw new Error(
        `[@taizan/nest-notify] 通道 "${kind}" 没有登记驱动（NotifyModule.forRoot 漏传了它）`,
      )
    }
    return driver
  }

  /**
   * @throws 模板不存在/已停用，或渲染时缺变量时抛（同步抛出，不产生任何 `NotifyRecord`——
   *   这是调用方的编程错误，不是"发送失败"）
   */
  async send(req: NotifySendRequest): Promise<NotifyResult[]> {
    const template = await this.templates.get(req.templateKey)
    if (!template) {
      throw new Error(`[@taizan/nest-notify] 未登记的模板 key："${req.templateKey}"`)
    }
    if (!template.enabled) {
      throw new Error(`[@taizan/nest-notify] 模板 "${req.templateKey}" 已停用`)
    }

    const content = renderTemplate(template.content, req.vars)
    const channelKinds: NotifyChannelKind[] =
      req.channels && req.channels.length > 0 ? req.channels : [template.channel]

    const message: NotifyMessage = {
      templateKey: req.templateKey,
      title: template.title,
      content,
      vars: req.vars,
      to: req.to,
      tenantId: req.tenantId,
      providerTemplateId: template.providerTemplateId,
    }

    const traceId = currentContext()?.traceId ?? ulid()
    const results: NotifyResult[] = []

    if (req.fallback === true) {
      // 降级：按顺序尝试，第一个成功就停。中间失败的那些是"预期内的正常降级"，
      // 不单独进重试队列——只有整条链都失败才需要重试，且只重试最后一次尝试的通道。
      let lastRecordId = ''
      let lastKind: NotifyChannelKind = channelKinds[0]!
      let succeeded = false
      for (const kind of channelKinds) {
        const driver = this.resolveDriver(kind)
        const result = await driver.send(message)
        const recordId = await writeNotifyRecord(this.prisma, kind, message, result, traceId)
        results.push(result)
        lastRecordId = recordId
        lastKind = kind
        if (result.ok) {
          succeeded = true
          break
        }
      }
      if (!succeeded) {
        await this.enqueueRetry({
          tenantId: req.tenantId,
          channel: lastKind,
          message,
          recordId: lastRecordId,
        })
      }
    } else {
      // 广播：列表里每个通道都独立尝试，各自的失败都要单独重试。
      for (const kind of channelKinds) {
        const driver = this.resolveDriver(kind)
        const result = await driver.send(message)
        const recordId = await writeNotifyRecord(this.prisma, kind, message, result, traceId)
        results.push(result)
        if (!result.ok) {
          await this.enqueueRetry({ tenantId: req.tenantId, channel: kind, message, recordId })
        }
      }
    }

    return results
  }

  private async enqueueRetry(payload: NotifyRetryPayload): Promise<void> {
    await this.queue.add(NOTIFY_RETRY_JOB, payload, { tenantId: payload.tenantId })
  }
}
