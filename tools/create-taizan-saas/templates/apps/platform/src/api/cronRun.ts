import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/**
 * cron 运行记录（T3-4 收尾③）：`GET /api/platform/jobs/cron-runs`，最近的在前，
 * 供运维核对 leader 锁是否正常（有没有实例在跑、跑没跑成），见
 * `apps/api/src/modules/platform/job/platform-job.service.ts` 的 `listCronRuns()`。
 * 页面挂在死信队列页（`PlatformJobDeadLetter.tsx`）的 Tab 里、不是独立一级菜单——
 * `apps/api/src/registry/menus.ts` 目前没有登记 `PlatformCronRuns` 这个 componentKey，
 * 新增一级菜单要改那份汇总文件（不在本次允许改动范围 `apps/admin/**`/`apps/platform/**`
 * 之内），见 README「需要后端补」一节给出的菜单定义建议。
 */
export interface CronRunView {
  id: string
  key: string
  startedAt: string
  finishedAt: string | null
  instanceId: string
  ok: boolean
  error: string | null
}

export const CRON_RUN_STATUS_TAGS: Record<string, StatusTagConfig> = {
  RUNNING: { text: '运行中', color: 'processing' },
  OK: { text: '成功', color: 'success' },
  FAILED: { text: '失败', color: 'error' },
}

function statusOf(row: CronRunView): keyof typeof CRON_RUN_STATUS_TAGS {
  return row.finishedAt === null ? 'RUNNING' : row.ok ? 'OK' : 'FAILED'
}

export function useCronRunApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery): Promise<PageResult<CronRunView & { status: string }>> =>
      req.get<PageResult<CronRunView>>('/api/platform/jobs/cron-runs', query).then((page) => ({
        ...page,
        items: page.items.map((row) => ({ ...row, status: statusOf(row) })),
      })),
  }
}
