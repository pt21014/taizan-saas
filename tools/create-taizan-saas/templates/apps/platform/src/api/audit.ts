import type { CrudListQuery } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** `GET /api/platform/audit-logs` 的一行（平台高危操作审计）。 */
export interface PlatformAuditLogView {
  id: string
  targetTenantId: string | null
  actorType: string
  actorId: string
  actorName: string
  action: string
  targetType: string | null
  targetId: string | null
  before: unknown
  after: unknown
  ip: string
  traceId: string
  result: string
  createdAt: string
}

/** `GET /api/platform/tenants/:tenantId/audit-logs` 的一行（某个租户的全量操作审计）。 */
export interface TenantAuditLogView {
  id: string
  tenantId: string
  actorType: string
  actorId: string
  actorName: string
  action: string
  targetType: string | null
  targetId: string | null
  before: unknown
  after: unknown
  ip: string
  traceId: string
  result: string
  createdAt: string
}

/** 审计模块的接口层，只读。 */
export function useAuditApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) =>
      req.get<PageResult<PlatformAuditLogView>>('/api/platform/audit-logs', query),
    listForTenant: (tenantId: string, query: CrudListQuery) =>
      req.get<PageResult<TenantAuditLogView>>(
        `/api/platform/tenants/${tenantId}/audit-logs`,
        query,
      ),
  }
}
