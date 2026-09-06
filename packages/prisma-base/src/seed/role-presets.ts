/**
 * 内置角色模板 seed。
 *
 * RolePreset 是**平台下发的角色模板**，建租户时按模板实例化成租户自己的 Role。
 * 与 Permission / Menu 一样，真源在代码，DB 只是镜像，所以这里每次都覆盖写。
 *
 * ## 权限点分两层，模板只认得其中一层
 *
 * 权限点分**框架自带**（`staff:*`、`role:*`、`audit:list`、`announcement:list`、
 * `profile:*`、`billing:*`；单一真源见 `@taizan/contracts` 的
 * `FRAMEWORK_PERMISSION_CODES`）与**业务自己注册**（如 `goods:*`，随业务项目的
 * `registry/permissions.ts` 走）两层。`prisma-base` 不依赖 `apps/api`，天生不认识
 * 业务权限码——给 `manager` / `staff` 塞一串猜的业务 code 只会比留空更糟（那串码
 * 大概率对不上业务项目实际注册的东西，静默变成死权限或者干脆炸在 spec 6 上）。
 *
 * 所以这里给的是**框架自带那一层**的合理默认，业务权限点由业务项目在自己的
 * seed（或角色配置页）里追加——README「已知取舍」一节写着这条。
 *
 * ## 三档默认
 *
 * - `owner`（店主）：`['*']`，恒为全量，不受这份清单影响。
 * - `manager`（店长）：框架自带权限点**全给**，除了两件事——`staff:transfer-owner`
 *   （转让店主，服务层本就只认店主本人）与 `role:delete`（删角色，对店长这一档
 *   风险太高），以及一件钱的事——`billing:order`（下单/续费真的花钱，只有店主
 *   能点这个按钮；`billing:view` 保留，店长该看得到账单）。用「全量减白名单」
 *   而不是「一条条加」，是因为框架以后新增自带权限点时，店长默认应该拿到它——
 *   新功能默认对管理者开放，比默认对谁都关着更符合直觉。
 * - `staff`（普通员工）：只给两条低风险的——`profile:read|write`（看/改自己的资料）
 *   与 `announcement:list`（看平台公告）。不给 `staff:*` / `role:*` / `audit:list`：
 *   一个刚入职的普通员工不该看到通讯录、动角色、翻审计日志。
 *
 * `super` / `ops` 是平台侧模板，框架自带权限点清单目前只覆盖商家侧（`ADMIN`），
 * 两条维持原样不动。
 */

import { FRAMEWORK_PERMISSION_CODES } from '@taizan/contracts'

import type { SeedDelegate } from './types'

/** 一个角色模板的 seed 数据。 */
export interface RolePresetSeedSpec {
  /** 模板 code，与 side 一起唯一。 */
  code: string
  /** 展示名。 */
  name: string
  /** 归属侧：商家后台 / 平台后台。 */
  side: 'ADMIN' | 'PLATFORM'
  /** 权限码数组；`['*']` = 全量。 */
  permissionCodes: string[]
}

/**
 * `manager` 模板里明确排除的框架权限点——理由见文件头。
 *
 * 用排除法而不是枚举法：`FRAMEWORK_PERMISSION_CODES` 以后新增的框架权限点，
 * 不在这份白名单里的话默认就给店长，不需要每加一条框架权限点都回来改这里。
 */
const MANAGER_EXCLUDED_CODES: readonly string[] = [
  'staff:transfer-owner',
  'role:delete',
  'billing:order',
]

/** `manager`：框架自带权限点全给，减去 {@link MANAGER_EXCLUDED_CODES}。 */
const MANAGER_PERMISSION_CODES: readonly string[] = FRAMEWORK_PERMISSION_CODES.filter(
  (code) => !MANAGER_EXCLUDED_CODES.includes(code),
)

/** `staff`：只给「改自己资料」与「看公告」——理由见文件头。 */
const STAFF_PERMISSION_CODES: readonly string[] = [
  'profile:read',
  'profile:write',
  'announcement:list',
]

/** 框架内置的角色模板。 */
export const BASE_ROLE_PRESETS: readonly RolePresetSeedSpec[] = [
  { code: 'owner', name: '店主', side: 'ADMIN', permissionCodes: ['*'] },
  {
    code: 'manager',
    name: '店长',
    side: 'ADMIN',
    permissionCodes: [...MANAGER_PERMISSION_CODES],
  },
  {
    code: 'staff',
    name: '普通员工',
    side: 'ADMIN',
    permissionCodes: [...STAFF_PERMISSION_CODES],
  },
  { code: 'super', name: '平台超管', side: 'PLATFORM', permissionCodes: ['*'] },
  { code: 'ops', name: '平台运营', side: 'PLATFORM', permissionCodes: [] },
]

/** {@link seedRolePresets} 的入参。 */
export interface SeedRolePresetsInput {
  /** `prisma.rolePreset` */
  delegate: SeedDelegate
  /** 主键生成器。 */
  newId: () => string
  /** 要写入的模板，默认 {@link BASE_ROLE_PRESETS}。 */
  specs?: readonly RolePresetSeedSpec[]
}

/**
 * 幂等地写入角色模板。
 *
 * @param input - 见 {@link SeedRolePresetsInput}
 * @returns 写入的模板 id 列表
 */
export async function seedRolePresets(input: SeedRolePresetsInput): Promise<string[]> {
  const specs = input.specs ?? BASE_ROLE_PRESETS
  const ids: string[] = []
  for (const spec of specs) {
    const payload = { name: spec.name, permissionCodes: spec.permissionCodes, builtin: true }
    const row = await input.delegate.upsert({
      where: { code_side: { code: spec.code, side: spec.side } },
      create: { id: input.newId(), code: spec.code, side: spec.side, ...payload },
      update: payload,
    })
    ids.push(row.id)
  }
  return ids
}
