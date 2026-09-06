/**
 * 模板来源：`templateKey → 模板定义`。
 *
 * 两种实现：`InMemoryTemplateSource`（`NotifyModule.forRoot({ templates })` 直接传
 * 一份对象，不查库——适合测试、适合项目还没跑 `NotifyTemplate` seed 的阶段）与
 * `PrismaTemplateSource`（查 `08-notify.prisma` 的 `NotifyTemplate` 表，全平台
 * 共享一份，不分租户，走 `prisma.raw`）。
 */
import { callOperation, type PrismaClientLike } from '@taizan/nest-prisma'
import { fromDbNotifyChannel } from './channel-map'
import type { NotifyChannelKind } from './types'

/** 一条模板定义。 */
export interface NotifyTemplateDef {
  title: string
  /** 正文，`{{var}}` 占位。 */
  content: string
  /** 默认通道：调用方没显式传 `channels` 时用它。 */
  channel: NotifyChannelKind
  /** 渠道侧模板 id（短信签名模板、微信订阅消息模板等）。 */
  providerTemplateId?: string
  enabled: boolean
}

export interface NotifyTemplateSource {
  get(templateKey: string): Promise<NotifyTemplateDef | null>
}

/** 内存模板源：`NotifyModule.forRoot({ templates })` 用。 */
export class InMemoryTemplateSource implements NotifyTemplateSource {
  constructor(private readonly templates: Record<string, NotifyTemplateDef>) {}

  async get(templateKey: string): Promise<NotifyTemplateDef | null> {
    return this.templates[templateKey] ?? null
  }
}

/** `NotifyTemplate` 在 Prisma 客户端上的属性名（camelCase）。 */
const NOTIFY_TEMPLATE = 'notifyTemplate'

/**
 * DB 模板源：查 `NotifyTemplate` 表。
 *
 * `NotifyTemplate` 是平台域表（蓝图 §3.2：模板全平台共享一份，租户不自定义），
 * 没有 `tenantId` 列，走 `prisma.raw` 是合法用途，不需要也不能走 `prisma.tenant`。
 */
export class PrismaTemplateSource implements NotifyTemplateSource {
  constructor(private readonly rawClient: PrismaClientLike) {}

  // raw-reason: NotifyTemplate 是平台域表，全平台共享一份，不受租户隔离约束
  async get(templateKey: string): Promise<NotifyTemplateDef | null> {
    const row = (await callOperation(this.rawClient, NOTIFY_TEMPLATE, 'findUnique', {
      where: { key: templateKey },
    })) as {
      title: string
      content: string
      // DB 枚举字面量（`IN_APP`/`WECHAT_MP`……），**不是**本包的 NotifyChannelKind——
      // 两套命名的转换见 `channel-map.ts` 文件头。这里故意标 string 而不是
      // `NotifyChannelKind`，免得下一个人以为它已经是本包的字面量、原样往下传。
      channel: string
      providerTemplateId: string | null
      enabled: boolean
    } | null
    if (!row) return null
    return {
      title: row.title,
      content: row.content,
      channel: fromDbNotifyChannel(row.channel),
      providerTemplateId: row.providerTemplateId ?? undefined,
      enabled: row.enabled,
    }
  }
}
