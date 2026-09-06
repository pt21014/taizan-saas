import type { CrudListQuery } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 商家自定义角色，对齐 `apps/api/src/modules/admin/role`（T1-9）。 */
export interface Role {
  id: string
  code: string
  name: string
  builtin: boolean
  permissionCodes: string[]
  /** 当前有几个员工挂着它；`> 0` 时删除按钮不该出现。 */
  staffCount: number
  createdAt: string
  updatedAt: string
}

export type RoleInput = Pick<Role, 'code' | 'name' | 'permissionCodes'>

/** `GET /api/admin/roles/permissions` 的一组：按模块分组的可勾选权限点目录。 */
export interface PermissionCatalogGroup {
  module: string
  items: { code: string; name: string; type: string }[]
}

/** 角色模块的接口层：五个函数 + 权限点目录。**没有 `get`**——角色控制器没有 `GET /:id`，
 * 编辑走 `openWith(row.id, row)`，列表接口本来就返回了全部字段（含 `permissionCodes`）。 */
export function useRolesApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) => req.get<PageResult<Role>>('/api/admin/roles', query),
    /** 可勾选的权限点目录（已经滤掉了 `platform-*`），供角色编辑页画勾选树。 */
    permissions: () => req.get<PermissionCatalogGroup[]>('/api/admin/roles/permissions'),
    create: (values: RoleInput) => req.post<Role>('/api/admin/roles', values),
    /** `AdminRoleController#update` 是 `PATCH`。 */
    update: (id: string, values: Partial<RoleInput>) =>
      req.patch<Role>(`/api/admin/roles/${id}`, values),
    /** `useCrudTable`/`table.removeRow` 要的是 `Promise<void>`，接口本身回一个 `{ id }`。 */
    remove: (row: Role) =>
      req.delete<{ id: string }>(`/api/admin/roles/${row.id}`).then(() => undefined),
  }
}
