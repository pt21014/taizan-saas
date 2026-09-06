import type { MenuNode } from './menu'

/**
 * `GET /api/admin/auth/bootstrap` 的响应形状（蓝图 §4.4）：一次请求拿全身份、租户、
 * 可切换店铺、已展开权限点、已裁剪菜单树、配额用量，前端登录/切店后只需调这一个接口，
 * 不再自己拼装多个接口的结果。
 */

/** 当前登录身份。 */
export interface BootstrapIdentity {
  /** 员工 ID（当前所在店铺下的成员身份） */
  staffId: string
  /** 账号 ID（跨店铺不变，一号多店场景下同一个 accountId 对应多个 staffId） */
  accountId: string
  /** 展示名 */
  name: string
  /** 头像 URL */
  avatar?: string | null
  /** 是否为店主（拥有该租户下的最高权限，不受角色配置限制） */
  isOwner: boolean
}

/** 当前所在租户（店铺）信息。 */
export interface BootstrapTenant {
  id: string
  slug: string
  name: string
  /** 租户状态；具体枚举值由业务侧 Prisma schema 定义，这里保持字符串以避免协议包反向依赖 schema */
  status: string
  /**
   * 套餐到期时间；蓝图 §4.5「到期永远现算，不落 EXPIRED 状态」，
   * 这里只是把 DB 里的原始到期日透传给前端，只读/打烊状态由 `readonly`/`closedReason` 表达。
   * 经 JSON 传输，统一用 ISO 字符串。
   */
  planExpireAt: string | null
  /** 后台是否已因到期/冻结转为只读（续费白名单路径不受此影响，前端据此禁用表单提交） */
  readonly: boolean
  /** C 端打烊原因；`null`/缺省表示未打烊 */
  closedReason?: string | null
  /** 套餐功能开关；`null` = 全部可用，`[]` = 一个都不给（三态语义见 `hasFeature`） */
  features: string[] | null
}

/** 一号多店场景下可切换的店铺条目。 */
export interface BootstrapShop {
  tenantId: string
  name: string
  slug: string
}

/** 单项配额的用量与上限；`limit: null` 表示不限量。 */
export interface BootstrapQuota {
  used: number
  limit: number | null
}

/** `GET /api/admin/auth/bootstrap` 的完整响应形状。 */
export interface BootstrapResponse {
  identity: BootstrapIdentity
  tenant: BootstrapTenant
  /** 一号多店的切换列表 */
  shops: BootstrapShop[]
  /** 已展开的权限点 code 列表 */
  permissions: string[]
  /** 服务端已按 权限 ∩ 套餐 features ∩ 显式禁用 裁剪后的菜单树 */
  menus: MenuNode[]
  /** 按配额种类（如 `'staff'`、`'storage'`）汇总的用量 */
  quotas: Record<string, BootstrapQuota>
}
