/**
 * 基础 seed 的单测。
 *
 * 用一个内存假 delegate 代替 Prisma：seed 的正确性问题几乎全在「幂等」与「别乱覆盖」上，
 * 这两件事不需要真数据库就能证伪，而需要真库的部分（唯一索引、外键）由 schema.spec 守。
 */

import { describe, expect, it } from 'vitest'

import { seedBase } from './index'
import { DEFAULT_ADMIN_USERNAME } from './platform-admin'
import { DEMO_OWNER_PHONE, DEMO_TENANT_SLUG, OWNER_ROLE_CODE } from './demo-tenant'
import { BASE_PLAN_SEEDS, STANDARD_PLAN_CODE, TRIAL_PLAN_CODE } from './plans'
import { BASE_ROLE_PRESETS } from './role-presets'
import { verifyPassword } from './password'
import type { SeedContext, SeedDelegate, SeedRow, SeedUpsertArgs } from './types'

/** 一个模型的内存表：按 where 的 JSON 形态当主键。 */
class FakeTable implements SeedDelegate {
  readonly rows = new Map<string, Record<string, unknown>>()
  /** 每次 upsert 的入参，用来断言「更新时没碰不该碰的列」。 */
  readonly calls: SeedUpsertArgs[] = []

  async upsert(args: SeedUpsertArgs): Promise<SeedRow> {
    this.calls.push(args)
    const key = JSON.stringify(args.where)
    const existing = this.rows.get(key)
    if (existing === undefined) {
      const created = { ...args.create }
      this.rows.set(key, created)
      return { id: created['id'] as string }
    }
    Object.assign(existing, args.update)
    return { id: existing['id'] as string }
  }

  get only(): Record<string, unknown> {
    expect(this.rows.size).toBe(1)
    return [...this.rows.values()][0] as Record<string, unknown>
  }
}

/** 全部 delegate 都收窄成 FakeTable，方便断言内部状态。 */
interface FakeContext extends SeedContext {
  platformAdmin: FakeTable
  plan: FakeTable
  tenant: FakeTable
  staffAccount: FakeTable
  staff: FakeTable
  role: FakeTable
  rolePreset: FakeTable
}

function newCtx(): FakeContext {
  return {
    platformAdmin: new FakeTable(),
    plan: new FakeTable(),
    tenant: new FakeTable(),
    staffAccount: new FakeTable(),
    staff: new FakeTable(),
    role: new FakeTable(),
    rolePreset: new FakeTable(),
  }
}

/** 单测里不需要真 ULID，用递增串好断言。 */
function counterIds(): () => string {
  let n = 0
  return () => `id-${(n += 1)}`
}

const NOW = new Date('2026-03-01T00:00:00.000Z')

describe('seedBase 产出', () => {
  it('建出平台管理员、两档套餐、演示租户与店主', async () => {
    const ctx = newCtx()
    const result = await seedBase(ctx, { now: NOW, newId: counterIds() })

    expect(result.platformAdmin.username).toBe(DEFAULT_ADMIN_USERNAME)
    expect(Object.keys(result.plans).sort()).toEqual(['standard', 'trial'])
    expect(result.demo?.tenant.slug).toBe(DEMO_TENANT_SLUG)
    expect(result.demo?.ownerAccount.phone).toBe(DEMO_OWNER_PHONE)
    expect(result.demo?.ownerRole.code).toBe(OWNER_ROLE_CODE)
    expect(result.rolePresetCount).toBe(BASE_ROLE_PRESETS.length)

    expect(ctx.platformAdmin.rows.size).toBe(1)
    expect(ctx.plan.rows.size).toBe(BASE_PLAN_SEEDS.length)
    expect(ctx.tenant.rows.size).toBe(1)
    expect(ctx.staffAccount.rows.size).toBe(1)
    expect(ctx.role.rows.size).toBe(1)
    expect(ctx.staff.rows.size).toBe(1)
  })

  it('管理员口令是 scrypt 哈希，明文不落库，admin123 能校验通过', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW, newId: counterIds() })
    const hash = ctx.platformAdmin.only['passwordHash'] as string
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(hash).not.toContain('admin123')
    await expect(verifyPassword('admin123', hash)).resolves.toBe(true)
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false)
  })

  it('店主口令 123456 能校验通过', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW, newId: counterIds() })
    await expect(
      verifyPassword('123456', ctx.staffAccount.only['passwordHash'] as string),
    ).resolves.toBe(true)
  })

  it('配额三态：体验版 STAFF=3 / TRAFFIC_MB=0，标准版 STAFF=null', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW, newId: counterIds() })
    const plans = [...ctx.plan.rows.values()]
    const trial = plans.find((p) => p['code'] === TRIAL_PLAN_CODE) as Record<string, unknown>
    const standard = plans.find((p) => p['code'] === STANDARD_PLAN_CODE) as Record<string, unknown>

    const trialQuotas = trial['quotas'] as Record<string, number | null>
    expect(trialQuotas['STAFF']).toBe(3)
    expect(trialQuotas['TRAFFIC_MB']).toBe(0)
    expect(trial['features']).toEqual(['member', 'order'])

    const standardQuotas = standard['quotas'] as Record<string, number | null>
    expect(standardQuotas['STAFF']).toBeNull()
    // 三态里最容易写错的一处：null 不是 undefined，也不是 0。
    expect('STAFF' in standardQuotas).toBe(true)
    expect(standardQuotas['STAFF']).not.toBe(0)
    // features: null = 全部功能开放。
    expect(standard['features']).toBeNull()
  })

  it('金额字段都是以 Cents 结尾的整数分', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW, newId: counterIds() })
    for (const plan of ctx.plan.rows.values()) {
      expect(Number.isInteger(plan['firstPriceCents'])).toBe(true)
      expect(Number.isInteger(plan['renewPriceCents'])).toBe(true)
    }
  })

  it('演示租户是 TRIAL、试用期按 trialDays 现算，且挂在体验版上', async () => {
    const ctx = newCtx()
    const result = await seedBase(ctx, { now: NOW, newId: counterIds(), trialDays: 7 })
    const tenant = ctx.tenant.only
    expect(tenant['status']).toBe('TRIAL')
    expect((tenant['trialEndAt'] as Date).toISOString()).toBe('2026-03-08T00:00:00.000Z')
    expect(tenant['planId']).toBe(result.plans.trial.id)
    expect(tenant['ownerAccountId']).toBe(result.demo?.ownerAccount.id)
  })

  it('店主成员关系：isOwner + dataScope=ALL + 绑内置 owner 角色', async () => {
    const ctx = newCtx()
    const result = await seedBase(ctx, { now: NOW, newId: counterIds() })
    const staff = ctx.staff.only
    expect(staff['isOwner']).toBe(true)
    expect(staff['dataScope']).toBe('ALL')
    expect(staff['roleIds']).toEqual([result.demo?.ownerRole.id])
    expect(ctx.role.only['permissionCodes']).toEqual(['*'])
    expect(ctx.role.only['builtin']).toBe(true)
  })

  it('withDemoTenant: false 时只建管理员与套餐', async () => {
    const ctx = newCtx()
    const result = await seedBase(ctx, {
      now: NOW,
      newId: counterIds(),
      withDemoTenant: false,
    })
    expect(result.demo).toBeUndefined()
    expect(ctx.tenant.rows.size).toBe(0)
    expect(ctx.staff.rows.size).toBe(0)
  })

  it('不传 rolePreset 时跳过角色模板', async () => {
    const ctx = newCtx()
    const { rolePreset: _dropped, ...rest } = ctx
    const result = await seedBase(rest as SeedContext, { now: NOW, newId: counterIds() })
    expect(result.rolePresetCount).toBe(0)
  })

  it('可以改用户名 / 手机号 / slug', async () => {
    const ctx = newCtx()
    const result = await seedBase(ctx, {
      now: NOW,
      newId: counterIds(),
      adminUsername: 'root',
      tenantSlug: 'acme',
      ownerPhone: '13900000000',
    })
    expect(result.platformAdmin.username).toBe('root')
    expect(result.demo?.tenant.slug).toBe('acme')
    expect(result.demo?.ownerAccount.phone).toBe('13900000000')
  })
})

describe('seedBase 幂等', () => {
  it('连跑两次不产生重复行，id 保持不变', async () => {
    const ctx = newCtx()
    const first = await seedBase(ctx, { now: NOW, newId: counterIds() })
    const second = await seedBase(ctx, { now: NOW, newId: counterIds() })

    expect(second.platformAdmin.id).toBe(first.platformAdmin.id)
    expect(second.plans.trial.id).toBe(first.plans.trial.id)
    expect(second.demo?.tenant.id).toBe(first.demo?.tenant.id)
    expect(second.demo?.ownerStaff.id).toBe(first.demo?.ownerStaff.id)

    expect(ctx.platformAdmin.rows.size).toBe(1)
    expect(ctx.plan.rows.size).toBe(BASE_PLAN_SEEDS.length)
    expect(ctx.tenant.rows.size).toBe(1)
    expect(ctx.staff.rows.size).toBe(1)
  })

  it('重跑不会重置已有管理员与店主的口令（seed 不能是后门）', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW, newId: counterIds() })
    const adminHash = ctx.platformAdmin.only['passwordHash']
    const ownerHash = ctx.staffAccount.only['passwordHash']

    await seedBase(ctx, {
      now: NOW,
      newId: counterIds(),
      adminPassword: 'changed-by-seed',
      ownerPassword: 'changed-by-seed',
    })

    expect(ctx.platformAdmin.only['passwordHash']).toBe(adminHash)
    expect(ctx.staffAccount.only['passwordHash']).toBe(ownerHash)
    await expect(verifyPassword('admin123', adminHash as string)).resolves.toBe(true)
  })

  it('重跑不刷新试用期（否则演示租户永远试不完，到期闸门测不到）', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW, newId: counterIds() })
    const trialEndAt = ctx.tenant.only['trialEndAt']

    await seedBase(ctx, { now: new Date('2027-01-01T00:00:00.000Z'), newId: counterIds() })
    expect(ctx.tenant.only['trialEndAt']).toBe(trialEndAt)
  })

  it('套餐价格与配额每次都覆盖（seed 是它们的真源）', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW, newId: counterIds() })
    const trialKey = JSON.stringify({ code: TRIAL_PLAN_CODE })
    const row = ctx.plan.rows.get(trialKey) as Record<string, unknown>
    row['firstPriceCents'] = 99999

    await seedBase(ctx, { now: NOW, newId: counterIds() })
    expect((ctx.plan.rows.get(trialKey) as Record<string, unknown>)['firstPriceCents']).toBe(0)
  })
})

describe('seedBase 的 upsert 用法', () => {
  it('按自然键定位：username / code / slug / phone', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW, newId: counterIds() })
    expect(ctx.platformAdmin.calls[0]?.where).toEqual({ username: 'admin' })
    expect(ctx.plan.calls[0]?.where).toEqual({ code: TRIAL_PLAN_CODE })
    expect(ctx.tenant.calls[0]?.where).toEqual({ slug: DEMO_TENANT_SLUG })
    expect(ctx.staffAccount.calls[0]?.where).toEqual({ phone: DEMO_OWNER_PHONE })
  })

  it('租户域两张表按「带 deletedAt 的复合唯一键」定位', async () => {
    const ctx = newCtx()
    const result = await seedBase(ctx, { now: NOW, newId: counterIds() })
    expect(ctx.role.calls[0]?.where).toEqual({
      tenantId_code_deletedAt: {
        tenantId: result.demo?.tenant.id,
        code: OWNER_ROLE_CODE,
        deletedAt: null,
      },
    })
    expect(ctx.staff.calls[0]?.where).toEqual({
      tenantId_accountId_deletedAt: {
        tenantId: result.demo?.tenant.id,
        accountId: result.demo?.ownerAccount.id,
        deletedAt: null,
      },
    })
  })

  it('create 里都带自己生成的 ULID 主键（schema 没有 @default(cuid())）', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW, newId: counterIds() })
    for (const table of [ctx.platformAdmin, ctx.plan, ctx.tenant, ctx.staffAccount, ctx.staff]) {
      for (const call of table.calls) {
        expect(typeof call.create['id']).toBe('string')
        expect((call.create['id'] as string).length).toBeGreaterThan(0)
      }
    }
  })

  it('默认用 @taizan/contracts 的 ulid() 生成主键', async () => {
    const ctx = newCtx()
    await seedBase(ctx, { now: NOW })
    expect(ctx.platformAdmin.only['id']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
