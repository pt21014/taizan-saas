import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/**
 * 死信查看/重放。接的是真实接口（T3-4）：
 * `GET /api/platform/jobs/dead-letters`（分页/按 queue 筛）+
 * `POST /api/platform/jobs/dead-letters/:id/replay`（真的重新入队，见
 * `apps/api/src/modules/platform/job/`）。
 */

/** 对齐 `apps/api/.../platform-job.service.ts` 的 `DeadLetterView`。 */
export interface JobDeadLetterView {
  id: string
  queue: string
  jobName: string
  originTenantId: string | null
  attempts: number
  lastError: string
  traceId: string
  createdAt: string
  resolvedAt: string | null
}

export const JOB_DEAD_LETTER_STATUS_TAGS: Record<string, StatusTagConfig> = {
  PENDING: { text: '待重放', color: 'error' },
  RESOLVED: { text: '已重放', color: 'success' },
}

function statusOf(row: JobDeadLetterView): keyof typeof JOB_DEAD_LETTER_STATUS_TAGS {
  return row.resolvedAt ? 'RESOLVED' : 'PENDING'
}

export function useJobDeadLetterApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery): Promise<PageResult<JobDeadLetterView & { status: string }>> =>
      req
        .get<PageResult<JobDeadLetterView>>('/api/platform/jobs/dead-letters', query)
        .then((page) => ({
          ...page,
          items: page.items.map((row) => ({ ...row, status: statusOf(row) })),
        })),
    replay: (row: JobDeadLetterView): Promise<void> =>
      req
        .post<{ jobId: string }>(`/api/platform/jobs/dead-letters/${row.id}/replay`)
        .then(() => undefined),
  }
}
