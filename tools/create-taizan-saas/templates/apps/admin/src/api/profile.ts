import { useSession } from '../session'

/**
 * 个人设置，对齐 `apps/api/src/modules/admin/profile`（T1-9）。
 *
 * `changePassword` 成功后，后端会把这个账号名下**所有店**的会话一起撤掉（含当前这一条）
 * ——`ProfileSettingsPage` 必须在拿到成功响应后立刻 `session.logout()` 并跳登录页，
 * 不跳的话下一个请求会拿到 `1140100`，用户看到的是一次莫名其妙的掉线。
 */
export interface ChangePasswordInput {
  oldPassword: string
  newPassword: string
}

export interface ChangePasswordResult {
  ok: true
  /** 一共撤掉了几家店的会话（一号多店时 > 1）。 */
  revokedStaffCount: number
}

export function useProfileApi() {
  const req = useSession((s) => s.request)
  return {
    changePassword: (values: ChangePasswordInput) =>
      req.post<ChangePasswordResult>('/api/admin/profile/change-password', values),
  }
}
