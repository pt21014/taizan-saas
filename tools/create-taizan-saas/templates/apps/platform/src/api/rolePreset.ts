import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** `RolePreset.side` 全集，对齐 `04-rbac.prisma` 的 `MenuSide`。 */
export const ROLE_PRESET_SIDES = ['ADMIN', 'PLATFORM'] as const

export const ROLE_PRESET_SIDE_TAGS: Record<string, StatusTagConfig> = {
  ADMIN: { text: '商家后台', color: 'blue' },
  PLATFORM: { text: '平台后台', color: 'purple' },
}

/** `GET /api/platform/role-presets` 的一行。 */
export interface RolePresetView {
  id: string
  code: string
  name: string
  side: string
  permissionCodes: string[]
  builtin: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateRolePresetInput {
  code: string
  name: string
  side: (typeof ROLE_PRESET_SIDES)[number]
  permissionCodes: string[]
}

export interface UpdateRolePresetInput {
  name?: string
  permissionCodes?: string[]
}

/** 角色预设模块的接口层。`builtin=true` 的行后端拒绝改/删，页面按 `row.builtin` 隐藏对应按钮。 */
export function useRolePresetApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) =>
      req.get<PageResult<RolePresetView>>('/api/platform/role-presets', query),
    get: (id: string) => req.get<RolePresetView>(`/api/platform/role-presets/${id}`),
    create: (values: CreateRolePresetInput) =>
      req.post<RolePresetView>('/api/platform/role-presets', values),
    update: (id: string, values: UpdateRolePresetInput) =>
      req.patch<RolePresetView>(`/api/platform/role-presets/${id}`, values),
    remove: (row: RolePresetView) =>
      req.delete<{ id: string }>(`/api/platform/role-presets/${row.id}`),
  }
}
