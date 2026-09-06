import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/**
 * 商家看**平台发来的**公告，对齐 `apps/api/src/modules/admin/announcement`（T1-9）。
 *
 * 方向是平台 → 商家：商家是读者，不是作者，所以这里只有 `list` 与 `markRead`，
 * 没有新建/编辑/删除——「商家自己发店内公告」是一个独立的、还没落地的业务需求
 * （需要新的租户域表），不是这一页该做的事。
 */
export interface Announcement {
  id: string
  title: string
  contentHtml: string
  /** `INFO` / `WARNING` / `CRITICAL`。 */
  level: string
  audience: string
  publishAt: string
  expireAt: string | null
  /** 当前这个员工读没读过。 */
  read: boolean
  readAt: string | null
}

export const ANNOUNCEMENT_READ: Record<'true' | 'false', StatusTagConfig> = {
  true: { text: '已读', color: 'success' },
  false: { text: '未读', color: 'warning' },
}

/** 公告模块的接口层：只读列表 + 标记已读。 */
export function useAnnouncementsApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) =>
      req.get<PageResult<Announcement>>('/api/admin/announcements', query),
    /** 幂等；重复调用不刷新首次已读时间。 */
    markRead: (id: string) => req.post<{ readAt: string }>(`/api/admin/announcements/${id}/read`),
  }
}
