/**
 * 平台公告 CRUD + 发布/下线 + 已读统计（T1-7）。
 *
 * `Announcement` / `AnnouncementRead` 都是平台域表（`06-ops.prisma`），全程走
 * `RawPrismaService`——属于 `raw-reasons.ts` 里 `src/modules/platform/` 整目录的豁免。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode, normalizePage, ulid, type PageResult } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import { Prisma } from '@prisma/client'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type {
  CreateAnnouncementDto,
  ListAnnouncementQueryDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto'

/** 下发给平台后台的公告行。 */
export interface AnnouncementView {
  id: string
  title: string
  contentHtml: string
  audience: string
  audienceRefs: string[] | null
  level: string
  publishAt: string
  expireAt: string | null
  status: string
  createdAt: string
  updatedAt: string
}

/** 已读统计：总数 + 按读者身份分组。 */
export interface AnnouncementReadStats {
  announcementId: string
  total: number
  byReaderType: Record<string, number>
}

type AnnouncementRow = NonNullable<
  Awaited<ReturnType<AppPrismaClient['announcement']['findUnique']>>
>

/** 同 `plan.service.ts` 的 `toFeaturesJson`：`Json?` 列的「显式 NULL」必须用 `Prisma.JsonNull`。 */
function toAudienceRefsJson(audienceRefs: string[] | null): string[] | typeof Prisma.JsonNull {
  return audienceRefs === null ? Prisma.JsonNull : audienceRefs
}

function toView(row: AnnouncementRow): AnnouncementView {
  return {
    id: row.id,
    title: row.title,
    contentHtml: row.contentHtml,
    audience: row.audience,
    audienceRefs: (row.audienceRefs as string[] | null) ?? null,
    level: row.level,
    publishAt: row.publishAt.toISOString(),
    expireAt: row.expireAt?.toISOString() ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

@Injectable()
export class PlatformAnnouncementService {
  constructor(
    // raw-reason: 平台后台——Announcement / AnnouncementRead 是平台域表，无租户维度。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
  ) {}

  async list(query: ListAnnouncementQueryDto): Promise<PageResult<AnnouncementView>> {
    const { page, pageSize } = normalizePage(query)
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.audience ? { audience: query.audience } : {}),
    }

    // raw-reason: 平台后台——公告列表，无租户维度。
    const [rows, total] = await Promise.all([
      this.raw.client.announcement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.raw.client.announcement.count({ where }),
    ])
    return { items: rows.map(toView), total, page, pageSize }
  }

  async get(id: string): Promise<AnnouncementView> {
    return toView(await this.requireAnnouncement(id))
  }

  /** @throws `BizException` 1040000 `expireAt` 早于或等于 `publishAt` */
  async create(dto: CreateAnnouncementDto): Promise<AnnouncementView> {
    const publishAt = new Date(dto.publishAt)
    const expireAt = dto.expireAt ? new Date(dto.expireAt) : null
    this.assertPublishWindow(publishAt, expireAt)

    // raw-reason: 平台后台——新建公告，无租户维度。
    const row = await this.raw.client.announcement.create({
      data: {
        id: ulid(),
        title: dto.title,
        contentHtml: dto.contentHtml,
        audience: dto.audience ?? 'ALL_TENANT',
        audienceRefs: toAudienceRefsJson(dto.audienceRefs ?? null),
        level: dto.level ?? 'INFO',
        publishAt,
        expireAt,
        status: 'DRAFT',
      },
    })
    return toView(row)
  }

  async update(id: string, dto: UpdateAnnouncementDto): Promise<AnnouncementView> {
    const current = await this.requireAnnouncement(id)
    const publishAt = dto.publishAt !== undefined ? new Date(dto.publishAt) : current.publishAt
    const expireAt =
      dto.expireAt !== undefined ? new Date(dto.expireAt) : (current.expireAt ?? null)
    this.assertPublishWindow(publishAt, expireAt)

    // raw-reason: 平台后台——修改公告，无租户维度。
    const row = await this.raw.client.announcement.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.contentHtml !== undefined ? { contentHtml: dto.contentHtml } : {}),
        ...(dto.audience !== undefined ? { audience: dto.audience } : {}),
        ...(dto.audienceRefs !== undefined ? { audienceRefs: dto.audienceRefs } : {}),
        ...(dto.level !== undefined ? { level: dto.level } : {}),
        ...(dto.publishAt !== undefined ? { publishAt } : {}),
        ...(dto.expireAt !== undefined ? { expireAt } : {}),
      },
    })
    return toView(row)
  }

  /** 发布：`DRAFT`/`ARCHIVED` → `PUBLISHED`。 */
  async publish(id: string): Promise<AnnouncementView> {
    const current = await this.requireAnnouncement(id)
    if (current.status === 'PUBLISHED') {
      throw new BizException(ErrorCode.BAD_REQUEST, '这条公告已经是发布状态了')
    }
    // raw-reason: 平台后台——发布公告，无租户维度。
    const row = await this.raw.client.announcement.update({
      where: { id },
      data: { status: 'PUBLISHED' },
    })
    return toView(row)
  }

  /** 下线：`PUBLISHED` → `ARCHIVED`。保留内容与已读回执，不是删除。 */
  async unpublish(id: string): Promise<AnnouncementView> {
    const current = await this.requireAnnouncement(id)
    if (current.status !== 'PUBLISHED') {
      throw new BizException(ErrorCode.BAD_REQUEST, '只有已发布的公告才能下线')
    }
    // raw-reason: 平台后台——公告下线，无租户维度。
    const row = await this.raw.client.announcement.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    })
    return toView(row)
  }

  /**
   * 删除。**仅限从未发布过的 `DRAFT`**——`Announcement` 没有 `deletedAt` 列（不做软删），
   * 一旦发布过就必须走「下线」保留历史与已读回执，不许物理删除把痕迹抹掉。
   */
  async remove(id: string): Promise<{ id: string }> {
    const current = await this.requireAnnouncement(id)
    if (current.status !== 'DRAFT') {
      throw new BizException(ErrorCode.BAD_REQUEST, '已发布过的公告不能删除，请用"下线"')
    }
    // raw-reason: 平台后台——删除草稿公告，无租户维度。
    await this.raw.client.announcement.delete({ where: { id } })
    return { id }
  }

  /** 已读统计：总数 + 按读者身份分组。全部走 `count`/`groupBy`，不 `findMany` 拖全表。 */
  async reads(id: string): Promise<AnnouncementReadStats> {
    await this.requireAnnouncement(id)
    // raw-reason: 平台后台——已读回执统计，AnnouncementRead 无租户维度。
    const [total, grouped] = await Promise.all([
      this.raw.client.announcementRead.count({ where: { announcementId: id } }),
      this.raw.client.announcementRead.groupBy({
        by: ['readerType'],
        where: { announcementId: id },
        _count: { _all: true },
      }),
    ])
    const byReaderType: Record<string, number> = {}
    for (const g of grouped as Array<{ readerType: string; _count: { _all: number } }>) {
      byReaderType[g.readerType] = g._count._all
    }
    return { announcementId: id, total, byReaderType }
  }

  private assertPublishWindow(publishAt: Date, expireAt: Date | null): void {
    if (expireAt && expireAt.getTime() <= publishAt.getTime()) {
      throw new BizException(ErrorCode.BAD_REQUEST, 'expireAt 必须晚于 publishAt')
    }
  }

  private async requireAnnouncement(id: string): Promise<AnnouncementRow> {
    // raw-reason: 平台后台——按 id 取公告，无租户维度。
    const row = await this.raw.client.announcement.findUnique({ where: { id } })
    if (!row) throw new BizException(ErrorCode.ANNOUNCEMENT_NOT_FOUND, '公告不存在')
    return row
  }
}
