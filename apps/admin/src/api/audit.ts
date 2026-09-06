import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 本店操作日志的一行，对齐 `apps/api/src/modules/admin/audit`（T1-9，只读）。 */
export interface AuditLogRow {
  id: string
  actorType: string
  actorId: string
  /** 操作者名字快照：人删了、改名了，日志上仍然是当时那个名字。 */
  actorName: string
  /** 动作码，`module.action` 形状，如 `staff.invite`。 */
  action: string
  targetType: string | null
  targetId: string | null
  before: unknown
  after: unknown
  ip: string
  traceId: string
  result: 'SUCCESS' | 'FAIL'
  createdAt: string
}

export const AUDIT_RESULT: Record<AuditLogRow['result'], StatusTagConfig> = {
  SUCCESS: { text: '成功', color: 'success' },
  FAIL: { text: '失败', color: 'error' },
}

/** 审计日志只读，接口层只有 `list`。 */
export function useAuditApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) =>
      req.get<PageResult<AuditLogRow>>('/api/admin/audit-logs', query),
  }
}
