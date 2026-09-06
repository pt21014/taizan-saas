/**
 * 框架基础 seed：把一个空库变成「能登进平台后台、能登进商家后台」的最小可用状态。
 *
 * ```ts
 * // apps/api/prisma/seed.ts
 * import { PrismaClient } from '@prisma/client'
 * import { seedBase } from '@taizan/prisma-base'
 *
 * const prisma = new PrismaClient() // 原始 client，不要套租户隔离扩展
 * await seedBase(prisma)
 * await prisma.$disconnect()
 * ```
 *
 * 三条硬约定：
 * 1. **全程 upsert，重复跑不出事**（幂等）；
 * 2. **不重置已有账号的口令**——seed 要是能改密码，它就是个后门；
 * 3. 只用 node 内置模块 + `@taizan/contracts`，不 import `@prisma/client`。
 */

import { ulid } from '@taizan/contracts'

import {
  DEMO_OWNER_NAME,
  DEMO_OWNER_PASSWORD,
  DEMO_OWNER_PHONE,
  DEMO_TENANT_NAME,
  DEMO_TENANT_SLUG,
  seedDemoTenant,
} from './demo-tenant'
import {
  DEFAULT_ADMIN_NAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  seedPlatformAdmin,
} from './platform-admin'
import { BASE_PLAN_SEEDS, TRIAL_PLAN_CODE, seedPlans } from './plans'
import { seedNotifyTemplates } from './notify-templates'
import { seedRolePresets } from './role-presets'
import type { SeedBaseOptions, SeedBaseResult, SeedContext } from './types'

export * from './password'
export * from './types'
export {
  DEMO_OWNER_NAME,
  DEMO_OWNER_PASSWORD,
  DEMO_OWNER_PHONE,
  DEMO_TENANT_NAME,
  DEMO_TENANT_SLUG,
  OWNER_ROLE_CODE,
  seedDemoTenant,
} from './demo-tenant'
export {
  DEFAULT_ADMIN_NAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  seedPlatformAdmin,
} from './platform-admin'
export {
  BASE_PLAN_SEEDS,
  STANDARD_PLAN_CODE,
  TRIAL_PLAN_CODE,
  seedPlans,
  type PlanSeedSpec,
} from './plans'
export { BASE_ROLE_PRESETS, seedRolePresets, type RolePresetSeedSpec } from './role-presets'
export {
  NOTIFY_TEMPLATE_KEYS,
  NOTIFY_TEMPLATE_SEEDS,
  PLAN_EXPIRE_STAGES,
  PLAN_EXPIRE_STAGE_DAYS_LEFT,
  planExpireInboxKey,
  planExpireSmsKey,
  seedNotifyTemplates,
  type NotifyTemplateSeedSpec,
  type PlanExpireStage,
  type SeedNotifyTemplatesInput,
} from './notify-templates'

/** 演示租户默认试用天数。 */
export const DEMO_TRIAL_DAYS = 14

/**
 * 跑一遍框架基础 seed。
 *
 * 产出：
 * - 平台管理员 `admin` / `admin123`（口令是 scrypt 哈希，格式见 `seed/password.ts`）；
 * - 两档套餐「体验版 / 标准版」，配额三态各演示一遍；
 * - 内置角色模板（传了 `ctx.rolePreset` 才写）；
 * - 一个 TRIAL 演示租户 `demo` + 店主 `13800000000` / `123456` + 店内内置角色 `owner`。
 *
 * @param ctx - Prisma delegate 集合，见 {@link SeedContext}；传原始 client 即可
 * @param options - 可选参数，见 {@link SeedBaseOptions}
 * @returns 建出的各行 id，见 {@link SeedBaseResult}
 * @throws {@link Error} 指定的套餐 code 不在 seed 清单里时
 */
export async function seedBase(
  ctx: SeedContext,
  options: SeedBaseOptions = {},
): Promise<SeedBaseResult> {
  const now = options.now ?? new Date()
  const newId = options.newId ?? ulid

  const platformAdmin = await seedPlatformAdmin({
    delegate: ctx.platformAdmin,
    newId,
    username: options.adminUsername ?? DEFAULT_ADMIN_USERNAME,
    password: options.adminPassword ?? DEFAULT_ADMIN_PASSWORD,
    name: options.adminName ?? DEFAULT_ADMIN_NAME,
  })

  const plans = await seedPlans({ delegate: ctx.plan, newId })
  const trial = plans[TRIAL_PLAN_CODE]
  const standard = plans[BASE_PLAN_SEEDS[1]?.code ?? '']
  if (trial === undefined || standard === undefined) {
    throw new Error('套餐 seed 结果里缺少体验版或标准版，BASE_PLAN_SEEDS 被改坏了。')
  }

  const rolePresetCount =
    ctx.rolePreset === undefined
      ? 0
      : (await seedRolePresets({ delegate: ctx.rolePreset, newId })).length

  const notifyTemplateCount =
    ctx.notifyTemplate === undefined
      ? 0
      : await seedNotifyTemplates({ delegate: ctx.notifyTemplate, newId })

  const result: SeedBaseResult = {
    platformAdmin,
    plans: { trial, standard },
    rolePresetCount,
    notifyTemplateCount,
  }

  if (options.withDemoTenant === false) return result

  result.demo = await seedDemoTenant({
    tenant: ctx.tenant,
    staffAccount: ctx.staffAccount,
    staff: ctx.staff,
    role: ctx.role,
    newId,
    now,
    slug: options.tenantSlug ?? DEMO_TENANT_SLUG,
    name: options.tenantName ?? DEMO_TENANT_NAME,
    trialDays: options.trialDays ?? DEMO_TRIAL_DAYS,
    planId: trial.id,
    ownerPhone: options.ownerPhone ?? DEMO_OWNER_PHONE,
    ownerPassword: options.ownerPassword ?? DEMO_OWNER_PASSWORD,
    ownerName: options.ownerName ?? DEMO_OWNER_NAME,
  })
  return result
}
