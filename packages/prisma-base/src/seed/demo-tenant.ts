/**
 * 演示租户 seed：一个 TRIAL 租户 + 店主登录账号 + 店内内置角色 owner + 成员关系。
 *
 * 建租户的顺序不是随便排的，`Tenant.ownerAccountId` 依赖 StaffAccount，
 * `Staff.roleIds` 依赖 Role，所以只能是 **账号 → 租户 → 角色 → 成员**。
 *
 * ⚠️ 这是「让本地能登进去看看」的最小造数，**不是** `@taizan/provision` 的替代品。
 * 真实建租户（自助注册、平台开通）只有 `@taizan/provision` 一条路（蓝图 spec 14），
 * 那条路还要建配额计数器、下发全套角色、写审计。别照抄这里的顺序去写业务代码。
 */

import { hashPassword } from './password'
import type { SeedDelegate } from './types'

/** 演示租户默认 slug。 */
export const DEMO_TENANT_SLUG = 'demo'

/** 演示租户默认名。 */
export const DEMO_TENANT_NAME = '演示商家'

/** 店主默认手机号。 */
export const DEMO_OWNER_PHONE = '13800000000'

/** 店主默认口令。**只用于本地开发，上线前必须改**。 */
export const DEMO_OWNER_PASSWORD = '123456'

/** 店主默认显示名。 */
export const DEMO_OWNER_NAME = '演示店主'

/** 内置店主角色的 code。 */
export const OWNER_ROLE_CODE = 'owner'

/** {@link seedDemoTenant} 的入参。 */
export interface SeedDemoTenantInput {
  /** `prisma.tenant` */
  tenant: SeedDelegate
  /** `prisma.staffAccount` */
  staffAccount: SeedDelegate
  /** `prisma.staff` */
  staff: SeedDelegate
  /** `prisma.role` */
  role: SeedDelegate
  /** 主键生成器。 */
  newId: () => string
  /** 基准时间。 */
  now: Date
  /** 租户 slug。 */
  slug: string
  /** 租户名。 */
  name: string
  /** 试用天数。 */
  trialDays: number
  /** 挂哪个套餐（Plan.id）。 */
  planId: string
  /** 店主手机号。 */
  ownerPhone: string
  /** 店主口令明文。 */
  ownerPassword: string
  /** 店主显示名。 */
  ownerName: string
}

/** {@link seedDemoTenant} 的产出。 */
export interface SeedDemoTenantResult {
  /** 租户。 */
  tenant: { id: string; slug: string }
  /** 店主登录账号。 */
  ownerAccount: { id: string; phone: string }
  /** 店内的店主角色。 */
  ownerRole: { id: string; code: string }
  /** 店主的成员关系。 */
  ownerStaff: { id: string }
}

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 幂等地建出演示租户全套数据。
 *
 * @param input - 见 {@link SeedDemoTenantInput}
 * @returns 建出的四行数据的 id，见 {@link SeedDemoTenantResult}
 */
export async function seedDemoTenant(input: SeedDemoTenantInput): Promise<SeedDemoTenantResult> {
  const passwordHash = await hashPassword(input.ownerPassword)

  // 1) 登录账号（平台域，手机号全局唯一）。同管理员：不重置已有口令。
  const account = await input.staffAccount.upsert({
    where: { phone: input.ownerPhone },
    create: {
      id: input.newId(),
      phone: input.ownerPhone,
      passwordHash,
      name: input.ownerName,
      status: 'ACTIVE',
    },
    update: { name: input.ownerName },
  })

  // 2) 租户。trialEndAt 现算，status 恒为 TRIAL——到期与否由闸门现算，不落 EXPIRED。
  const trialEndAt = new Date(input.now.getTime() + input.trialDays * DAY_MS)
  const tenant = await input.tenant.upsert({
    where: { slug: input.slug },
    create: {
      id: input.newId(),
      slug: input.slug,
      name: input.name,
      status: 'TRIAL',
      planId: input.planId,
      planExpireAt: trialEndAt,
      trialEndAt,
      graceDays: 3,
      retentionDays: 7,
      ownerAccountId: account.id,
    },
    // 重跑 seed 不刷新试用期，否则演示租户永远试用不完，到期闸门也就永远测不到。
    update: { name: input.name, ownerAccountId: account.id },
  })

  // 3) 店内内置角色。`["*"]` = 全量权限，只给店主用。
  const role = await input.role.upsert({
    where: {
      tenantId_code_deletedAt: { tenantId: tenant.id, code: OWNER_ROLE_CODE, deletedAt: null },
    },
    create: {
      id: input.newId(),
      tenantId: tenant.id,
      code: OWNER_ROLE_CODE,
      name: '店主',
      permissionCodes: ['*'],
      menuKeys: null,
      builtin: true,
    },
    update: { name: '店主', permissionCodes: ['*'], builtin: true },
  })

  // 4) 成员关系。isOwner 与 dataScope=ALL 一起给：店主看全店数据。
  const staff = await input.staff.upsert({
    where: {
      tenantId_accountId_deletedAt: { tenantId: tenant.id, accountId: account.id, deletedAt: null },
    },
    create: {
      id: input.newId(),
      tenantId: tenant.id,
      accountId: account.id,
      name: input.ownerName,
      status: 'ACTIVE',
      roleIds: [role.id],
      dataScope: 'ALL',
      scopeTargets: null,
      isOwner: true,
      joinedAt: input.now,
    },
    update: { status: 'ACTIVE', roleIds: [role.id], dataScope: 'ALL', isOwner: true },
  })

  return {
    tenant: { id: tenant.id, slug: input.slug },
    ownerAccount: { id: account.id, phone: input.ownerPhone },
    ownerRole: { id: role.id, code: OWNER_ROLE_CODE },
    ownerStaff: { id: staff.id },
  }
}
