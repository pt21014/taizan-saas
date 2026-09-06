import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 平台管理员启停状态全集，对齐 `apps/api/.../platform-admin.dto.ts` 的 `ADMIN_STATUSES`。 */
export const ADMIN_STATUSES = ['ACTIVE', 'DISABLED'] as const

export const ADMIN_STATUS_TAGS: Record<string, StatusTagConfig> = {
  ACTIVE: { text: '启用', color: 'success' },
  DISABLED: { text: '停用', color: 'default' },
}

/** `GET /api/platform/admins` 的一行。 */
export interface AdminView {
  id: string
  username: string
  name: string
  status: string
  roleIds: string[]
  lastLoginAt: string | null
  createdAt: string
}

/** 新建平台管理员。 */
export interface CreateAdminInput {
  username: string
  /** 不填就随机生成一个，回填在 `AdminSecretResult.initialPassword` 里 */
  password?: string
  name: string
  roleIds?: string[]
}

/** 修改（名字 / 角色，不改用户名与状态）。 */
export interface UpdateAdminInput {
  name?: string
  roleIds?: string[]
}

/** 创建/重置口令的产出：只在**没有显式指定口令**时回明文。 */
export interface AdminSecretResult {
  admin: AdminView
  initialPassword: string | null
}

/** 平台管理员模块的接口层：`apps/platform/src/api/*.ts` 每个模块一份，五个基础函数 + 专属动作。 */
export function useAdminApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) => req.get<PageResult<AdminView>>('/api/platform/admins', query),
    get: (id: string) => req.get<AdminView>(`/api/platform/admins/${id}`),
    create: (values: CreateAdminInput) =>
      req.post<AdminSecretResult>('/api/platform/admins', values),
    update: (id: string, values: UpdateAdminInput) =>
      req.patch<AdminView>(`/api/platform/admins/${id}`, values),
    // 没有「删除管理员」这个动作——后端只给启停，删除会让审计记录里的 actorId 悬空；
    // useCrudTable() 的 remove 本来就是可选项，这里干脆不传，列表页也就不会渲染「删除」按钮。
    setPassword: (id: string, newPassword?: string) =>
      req.patch<AdminSecretResult>(`/api/platform/admins/${id}/password`, { newPassword }),
    enable: (id: string) => req.patch<AdminView>(`/api/platform/admins/${id}/enable`),
    disable: (id: string) => req.patch<AdminView>(`/api/platform/admins/${id}/disable`),
  }
}
