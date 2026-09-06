/**
 * `NotifyRecord`（租户域）/ `PlatformNotifyRecord`（平台域）的读写。
 *
 * 单独抽出来是为了"有 tenantId 走 tenant 句柄，没有走 raw"这条分支只写一次——
 * `NotifyService`（记录每个通道的发送结果）与 `NotifyRetryHandler`（重试后更新
 * 状态）都要用同一条判断逻辑，写两遍迟早会有一处漏改。
 *
 * 两张表拆开的理由与 `AuditLog`/`PlatformAuditLog` 一样：不给隔离留可空
 * `tenantId` 的例外。
 */
import { callOperation, type PrismaClientLike } from '@taizan/nest-prisma'
import { ulid } from '@taizan/contracts'
import { toDbNotifyChannel } from './channel-map'
import type { NotifyChannelKind, NotifyMessage, NotifyResult } from './types'

/** `NotifyRecord`/`PlatformNotifyRecord` 在 Prisma 客户端上的属性名（camelCase）。 */
const NOTIFY_RECORD = 'notifyRecord'
const PLATFORM_NOTIFY_RECORD = 'platformNotifyRecord'

export type NotifyRecordStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED'

/** 提供 `.tenant`/`.raw` 两个句柄的最小接口（`PrismaService` 满足它）。 */
export interface NotifyPrisma {
  tenant: PrismaClientLike
  raw: PrismaClientLike
}

function toStorageStatus(result: Pick<NotifyResult, 'ok'>): NotifyRecordStatus {
  return result.ok ? 'SENT' : 'FAILED'
}

function toStorageTo(channel: NotifyChannelKind, message: NotifyMessage): string {
  switch (channel) {
    case 'SMS':
      return message.to.phone ?? ''
    case 'MP_TEMPLATE':
      return message.to.openId ?? ''
    case 'APP_PUSH':
      return message.to.deviceToken ?? ''
    case 'INBOX':
      return message.to.userId ?? ''
  }
}

async function insertOne(
  prisma: NotifyPrisma,
  tenantId: string | undefined,
  base: Record<string, unknown>,
): Promise<string> {
  if (tenantId) {
    await callOperation(prisma.tenant, NOTIFY_RECORD, 'create', { data: base })
  } else {
    // raw-reason: 平台域通知记录（NotifySendRequest.tenantId 未传，调用方显式声明这是平台通知）
    await callOperation(prisma.raw, PLATFORM_NOTIFY_RECORD, 'create', {
      data: { ...base, targetTenantId: null },
    })
  }
  return base['id'] as string
}

/**
 * 写发送结果记录，返回**最后一条**记录的 id（供重试时定位这一行——重试针对的
 * 是这个通道最终呈现给用户的那次尝试，不是中间失败的那次）。
 *
 * `result.attempts` 有内容时（目前只有 SMS 通道会填）按它展开成多条记录：
 * 主厂商失败切备用时，两次尝试都要能在排障时看到，不能只留最后一次。没有
 * `attempts` 时（其它通道）只写一条，用 `result` 本身的状态。
 *
 * `message.tenantId` 有值走 `prisma.tenant`（租户隔离扩展自动注入 `tenantId`）；
 * 没有值走 `prisma.raw` 写 `PlatformNotifyRecord`——这不是"忘了传当成平台"的
 * 静默兜底，是 `NotifySendRequest.tenantId` 本身就是可选字段，调用方显式决定
 * 这是不是一条平台通知。
 */
export async function writeNotifyRecord(
  prisma: NotifyPrisma,
  channel: NotifyChannelKind,
  message: NotifyMessage,
  result: NotifyResult,
  traceId: string,
): Promise<string> {
  const to = toStorageTo(channel, message)
  // 落库前必须转换成 DB 枚举字面量——`channel` 本身是本包的 NotifyChannelKind
  // （`INBOX`/`MP_TEMPLATE` 这两个字面量在 `08-notify.prisma` 的枚举里根本不存在），
  // 见文件头引用的 `channel-map.ts` 与它文件头写的那条 T1-5 真实 bug。
  const dbChannel = toDbNotifyChannel(channel)
  const rows =
    result.attempts && result.attempts.length > 0
      ? result.attempts
      : [{ ok: result.ok, vendorRef: result.vendorRef, error: result.error }]

  let lastId = ''
  for (const attempt of rows) {
    const id = ulid()
    lastId = await insertOne(prisma, message.tenantId, {
      id,
      channel: dbChannel,
      templateKey: message.templateKey,
      to,
      vars: message.vars,
      status: toStorageStatus(attempt),
      error: attempt.ok ? null : (attempt.error ?? '未知错误'),
      traceId,
      sentAt: attempt.ok ? new Date() : null,
    })
  }
  return lastId
}

/** 重试成功/最终失败后更新那一行的状态。 */
export async function updateNotifyRecordStatus(
  prisma: NotifyPrisma,
  recordId: string,
  tenantId: string | undefined,
  result: NotifyResult,
): Promise<void> {
  const data = {
    status: toStorageStatus(result),
    error: result.ok ? null : (result.error ?? '未知错误'),
    sentAt: result.ok ? new Date() : null,
  }
  if (tenantId) {
    await callOperation(prisma.tenant, NOTIFY_RECORD, 'update', { where: { id: recordId }, data })
  } else {
    // raw-reason: 平台域通知记录，见 writeNotifyRecord 的同一处说明
    await callOperation(prisma.raw, PLATFORM_NOTIFY_RECORD, 'update', {
      where: { id: recordId },
      data,
    })
  }
}
