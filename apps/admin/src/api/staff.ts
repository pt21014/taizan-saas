import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/**
 * 员工模块的接口层，对齐 `apps/api/src/modules/admin/staff`（T1-9）。
 *
 * 两处形状上的取舍是后端定的，前端只是照抄：
 * - **没有「新建员工」**，只有「邀请」（`POST /invites` 生成一张邀请，人接受了才真的
 *   多出一个 `Staff` 行）——所以这里没有 `create`，只有 `createInvite`。
 * - **没有「删除员工」**，只有「停用/启用」（`POST /:id/disable|enable`）——软删会让
 *   历史单据的操作人指向一个查不到的 id，商家真正想要的是「他不能再登进来」。
 */
export interface Staff {
  id: string
  accountId: string
  /** 店内昵称，可与账号显示名不同。 */
  name: string
  /** 登录手机号；账号被物理删过时是空串。 */
  phone: string
  status: 'ACTIVE' | 'DISABLED' | 'LEFT'
  isOwner: boolean
  roleIds: string[]
  /** 与 `roleIds` 一一对应；角色被删掉的那些不出现在这里。 */
  roleNames: string[]
  dataScope: string
  joinedAt: string
  createdAt: string
  updatedAt: string
}

/** 改员工：只改传了的字段（`UpdateStaffDto`）。 */
export interface StaffUpdateInput {
  name?: string
  roleIds?: string[]
}

/** 生成一张邀请（`CreateStaffInviteDto`）。 */
export interface StaffInviteInput {
  /** 限定手机号；不填 = 任何人凭链接可入。 */
  phone?: string
  roleIds: string[]
  /** 有效期（小时），默认 72，上限 720。 */
  expiresInHours?: number
}

/** `POST /invites` 的响应。`token` 本身就是凭证。 */
export interface StaffInviteView {
  id: string
  token: string
  /** 后端给的是 `/api/public/invites/:token`；前端要拼成落地页地址发给被邀请人。 */
  acceptPath: string
  phone: string | null
  roleIds: string[]
  expiresAt: string
  createdAt: string
}

/** 转让店主的入参与结果。 */
export interface TransferOwnerInput {
  staffId: string
}

export interface TransferOwnerResult {
  newOwnerStaffId: string
  previousOwnerStaffId: string
  demotedToRoleId: string | null
}

export const STAFF_STATUS: Record<Staff['status'], StatusTagConfig> = {
  ACTIVE: { text: '在职', color: 'success' },
  DISABLED: { text: '已停用', color: 'default' },
  LEFT: { text: '已离职', color: 'default' },
}

/** 员工模块的接口层。 */
export function useStaffApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) => req.get<PageResult<Staff>>('/api/admin/staff', query),
    /** 生成一张邀请（不扣配额；配额在被邀请人接受时才扣）。 */
    createInvite: (values: StaffInviteInput) =>
      req.post<StaffInviteView>('/api/admin/staff/invites', values),
    /** 改店内昵称 / 角色；`AdminStaffController#update` 是 `PATCH`。 */
    update: (id: string, values: StaffUpdateInput) =>
      req.patch<Staff>(`/api/admin/staff/${id}`, values),
    disable: (row: Staff) => req.post<Staff>(`/api/admin/staff/${row.id}/disable`),
    enable: (row: Staff) => req.post<Staff>(`/api/admin/staff/${row.id}/enable`),
    /** 转让店主：仅店主本人可调，转让后自己降为店长/普通员工角色。 */
    transferOwner: (values: TransferOwnerInput) =>
      req.post<TransferOwnerResult>('/api/admin/staff/transfer-owner', values),
  }
}
