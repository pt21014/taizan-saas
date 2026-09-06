import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

export const ANNOUNCEMENT_AUDIENCES = ['ALL_TENANT', 'PLAN', 'TENANT_IDS', 'C_END'] as const
export const ANNOUNCEMENT_LEVELS = ['INFO', 'WARNING', 'CRITICAL'] as const
export const ANNOUNCEMENT_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const

export const ANNOUNCEMENT_AUDIENCE_LABELS: Record<string, string> = {
  ALL_TENANT: '全部租户',
  PLAN: '按套餐',
  TENANT_IDS: '指定租户',
  C_END: 'C 端用户',
}

export const ANNOUNCEMENT_LEVEL_TAGS: Record<string, StatusTagConfig> = {
  INFO: { text: '提示', color: 'blue' },
  WARNING: { text: '警告', color: 'warning' },
  CRITICAL: { text: '严重', color: 'error' },
}

export const ANNOUNCEMENT_STATUS_TAGS: Record<string, StatusTagConfig> = {
  DRAFT: { text: '草稿', color: 'default' },
  PUBLISHED: { text: '已发布', color: 'success' },
  ARCHIVED: { text: '已下线', color: 'default' },
}

/** `GET /api/platform/announcements` 的一行。 */
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

export interface AnnouncementReadStats {
  announcementId: string
  total: number
  byReaderType: Record<string, number>
}

export interface CreateAnnouncementInput {
  title: string
  contentHtml: string
  audience?: (typeof ANNOUNCEMENT_AUDIENCES)[number]
  audienceRefs?: string[]
  level?: (typeof ANNOUNCEMENT_LEVELS)[number]
  publishAt: string
  expireAt?: string
}

export type UpdateAnnouncementInput = Partial<CreateAnnouncementInput>

/** 公告模块的接口层：新建落 DRAFT，发布/下线是独立动作，已读统计走单独接口。 */
export function useAnnouncementApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) =>
      req.get<PageResult<AnnouncementView>>('/api/platform/announcements', query),
    get: (id: string) => req.get<AnnouncementView>(`/api/platform/announcements/${id}`),
    create: (values: CreateAnnouncementInput) =>
      req.post<AnnouncementView>('/api/platform/announcements', values),
    update: (id: string, values: UpdateAnnouncementInput) =>
      req.patch<AnnouncementView>(`/api/platform/announcements/${id}`, values),
    remove: (row: AnnouncementView) =>
      req.delete<{ id: string }>(`/api/platform/announcements/${row.id}`),
    publish: (id: string) =>
      req.patch<AnnouncementView>(`/api/platform/announcements/${id}/publish`),
    unpublish: (id: string) =>
      req.patch<AnnouncementView>(`/api/platform/announcements/${id}/unpublish`),
    reads: (id: string) =>
      req.get<AnnouncementReadStats>(`/api/platform/announcements/${id}/reads`),
  }
}
