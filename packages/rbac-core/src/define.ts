import type { MenuSide } from '@taizan/contracts'
import { isWildcardCode, normalizeCode } from './permission'

/**
 * 角色预设定义与角色授予规则（蓝图 §3.2 的 `RolePreset` 表、§4.4）。
 *
 * 角色预设是**平台下发给租户的角色模板**（`RolePreset.builtin`），开通租户时按模板生成
 * 租户自己的 `Role`。模板里的权限点必须在代码注册表里存在——否则新租户一开通就带着一批
 * 永远不会命中的死权限，前端菜单也会跟着裁出空目录。
 */

/** 角色预设 code 的格式：小写字母开头的 kebab-case，如 `'shop-owner'`、`'cashier'`。 */
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9-]*$/

/** {@link defineRolePreset} 的入参。 */
export interface RolePresetInput {
  /** 角色预设 code，租户内唯一，格式 kebab-case */
  code: string
  /** 角色中文名 */
  name: string
  /** 所属侧：商家后台 `ADMIN` 或平台超管后台 `PLATFORM` */
  side: MenuSide
  /**
   * 权限点 code 列表，**允许写通配** `'goods:*'` / `'*'`，会在这里按注册表展开成具体 code。
   * 展开后的结果是可枚举、可审计的，DB 里落的也是展开后的具体 code。
   */
  permissionCodes: string[]
}

/** {@link defineRolePreset} 的返回值：冻结后的角色预设。 */
export interface RolePreset {
  readonly code: string
  readonly name: string
  readonly side: MenuSide
  /** 已展开（通配已解开）、已去重、已按字典序排好的权限点 code 列表 */
  readonly permissionCodes: readonly string[]
}

/**
 * 定义一个角色预设。
 *
 * 校验与规整：
 * - `code` 必须是 kebab-case，`name` 不能为空；
 * - `permissionCodes` 里的通配按 `allCodes` 展开；展开后为空的通配视为写错，抛错；
 * - 每个非通配 code 必须格式合法且**在 `allCodes` 里存在**，否则抛错（写入侧严格，
 *   与 `expandRoles` 读取侧的宽松刻意相反：脏数据不该在这里被造出来）；
 * - 结果去重并按字典序排序，保证同一份定义在任何机器上生成同样的 DB 行，便于同步命令幂等。
 *
 * @param input - 角色预设定义
 * @param allCodes - 全部已注册权限点 code（来自代码注册表）。**必填**：不给注册表就无从校验，
 *   与其静默跳过校验，不如要求调用方显式把注册表传进来
 * @returns 冻结后的角色预设对象
 *
 * @example
 * ```ts
 * const CASHIER = defineRolePreset(
 *   { code: 'cashier', name: '收银员', side: 'ADMIN', permissionCodes: ['order:*', 'goods:list'] },
 *   permissionCodesOf(PERMISSIONS),
 * )
 * ```
 */
export function defineRolePreset(input: RolePresetInput, allCodes: Iterable<string>): RolePreset {
  if (!ROLE_CODE_PATTERN.test(input.code)) {
    throw new Error(
      `[@taizan/rbac-core] 角色预设 code "${input.code}" 不符合 kebab-case 格式（如 'shop-owner'）`,
    )
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new Error(`[@taizan/rbac-core] 角色预设 "${input.code}" 的 name 不能为空`)
  }
  if (input.side !== 'ADMIN' && input.side !== 'PLATFORM') {
    throw new Error(`[@taizan/rbac-core] 角色预设 "${input.code}" 的 side 只能是 ADMIN 或 PLATFORM`)
  }

  const registry = new Set<string>(allCodes)
  const expanded = new Set<string>()

  for (const raw of input.permissionCodes) {
    const code = typeof raw === 'string' ? raw.trim() : ''
    if (code.length === 0) {
      throw new Error(`[@taizan/rbac-core] 角色预设 "${input.code}" 的 permissionCodes 里有空 code`)
    }

    if (isWildcardCode(code)) {
      const prefix = code === '*' ? '' : code.slice(0, -1)
      const matched = [...registry].filter((item) => item.startsWith(prefix))
      if (matched.length === 0) {
        throw new Error(
          `[@taizan/rbac-core] 角色预设 "${input.code}" 的通配权限 "${code}" 没有匹配到任何已注册权限点`,
        )
      }
      for (const item of matched) {
        expanded.add(item)
      }
      continue
    }

    const normalized = normalizeCode(code)
    if (!registry.has(normalized)) {
      throw new Error(
        `[@taizan/rbac-core] 角色预设 "${input.code}" 引用了未注册的权限点 "${normalized}"`,
      )
    }
    expanded.add(normalized)
  }

  return Object.freeze({
    code: input.code,
    name: input.name.trim(),
    side: input.side,
    permissionCodes: Object.freeze([...expanded].sort()),
  })
}

/**
 * 店主角色的授予规则常量。
 *
 * 「店主」不是一个可以被勾选的角色：它是 `Staff.isOwner` 这一位，只能通过**转让店铺**流程
 * 从旧店主身上移到新店主身上（转让是一个带审计、带二次确认的独立动作）。
 * 如果允许通过「授予角色」产生店主，就等价于任何拿到「员工管理」权限的人都能给自己提权。
 */
export const ASSIGNABLE_ROLE_RULE = {
  code: 'OWNER_ROLE_NOT_ASSIGNABLE',
  /** 规则说明，可直接作为接口返回的 message */
  message: '店主身份只能通过「转让店铺」流程转移，不能通过授予/撤销角色产生或移除',
} as const

/** {@link canAssignRole} 的操作者画像。 */
export interface RoleAssignActor {
  /** 操作者是否是店主 */
  isOwner: boolean
  /** 操作者所在侧；给出时会与目标角色的 side 比对 */
  side?: MenuSide
}

/** {@link canAssignRole} 的目标角色画像。 */
export interface AssignableRole {
  /** 该角色是否等价于「店主」（`RolePreset`/`Role` 上的店主标记） */
  isOwnerRole: boolean
  /** 该角色所属侧；给出时会与操作者的 side 比对 */
  side?: MenuSide
}

/**
 * 判断操作者能否授予 / 撤销某个角色。
 *
 * 规则（{@link ASSIGNABLE_ROLE_RULE}）：
 * 1. **店主角色永远不可授予、也不可撤销**——非店主不能授予店主角色（否则是自助提权），
 *    店主自己也不能通过角色授予把店主身份交出去（那条路是「转让店铺」）。所以只要
 *    `targetRole.isOwnerRole` 为真，无论操作者是不是店主一律返回 `false`。
 * 2. 双方都给出 `side` 且不一致时返回 `false`：商家后台的员工不能授予平台侧角色，反之亦然。
 * 3. 其余情况返回 `true`。
 *
 * 这里只判定「这个角色本身允不允许被这样操作」，**不判定操作者有没有 `staff:write`
 * 之类的接口权限**——那由 `@RequirePermission` 负责，两层各管一段。
 */
export function canAssignRole(actor: RoleAssignActor, targetRole: AssignableRole): boolean {
  if (targetRole.isOwnerRole) {
    return false
  }
  if (actor.side !== undefined && targetRole.side !== undefined && actor.side !== targetRole.side) {
    return false
  }
  return true
}
