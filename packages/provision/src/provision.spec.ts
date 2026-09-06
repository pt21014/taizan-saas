import { describe, expect, it } from 'vitest'

import { FAKE_PRESETS, createFakeTx, createIdGen } from './__test__/fake-tx'
import { OWNER_ROLE_CODE, buildProvisionAudit, provisionTenant } from './provision'
import type { ProvisionDeps } from './provision'
import { isProvisionError } from './types'
import type { ProvisionErrorReason, ProvisionInput, StaffAccountRow } from './types'

/** 固定「现在」：2026-03-01 09:00（+08:00）。试用到期落在哪一天必须可复现。 */
const NOW = new Date('2026-03-01T01:00:00.000Z')

/** 假哈希：`hash:<明文>`。本包不做哈希，只负责在对的位置调对的函数。 */
function createDeps(overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    now: () => NOW,
    ulid: createIdGen(),
    hashPassword: (plain) => `hash:${plain}`,
    verifyPassword: (plain, hash) => hash === `hash:${plain}`,
    ...overrides,
  }
}

const BASE: ProvisionInput = {
  slug: 'my-shop',
  name: '我的小店',
  ownerPhone: '13800000000',
  ownerPassword: 'abcd1234',
  source: 'SIGNUP',
}

const EXISTING_ACCOUNT: StaffAccountRow = {
  id: 'acc-old',
  phone: '13800000000',
  passwordHash: 'hash:abcd1234',
  name: '老板',
  status: 'ACTIVE',
}

/** 跑一次并断言它抛了带某个 reason 的 ProvisionError，返回失败时的调用序列。 */
async function expectReason(
  reason: ProvisionErrorReason,
  input: Partial<ProvisionInput>,
  fake = createFakeTx(),
  deps = createDeps(),
): Promise<string[]> {
  let thrown: unknown
  try {
    await provisionTenant(fake.tx, { ...BASE, ...input }, deps)
  } catch (error) {
    thrown = error
  }
  expect(isProvisionError(thrown), `期望抛 ProvisionError(${reason})，实际 ${String(thrown)}`).toBe(
    true,
  )
  if (isProvisionError(thrown)) expect(thrown.reason).toBe(reason)
  return fake.seq()
}

describe('provisionTenant / 落库前的校验', () => {
  it('保留字 slug 被拒，且**一次库都没查**', async () => {
    const fake = createFakeTx()
    expect(await expectReason('SLUG_RESERVED', { slug: 'admin' }, fake)).toEqual([])
  })

  it('形状不合法的 slug 被拒', async () => {
    await expectReason('SLUG_INVALID', { slug: 'My_Shop' })
  })

  it('店名不合法被拒', async () => {
    await expectReason('NAME_INVALID', { name: '店' })
  })

  it('手机号不合法被拒（归一化之后再判）', async () => {
    await expectReason('PHONE_INVALID', { ownerPhone: '+86 12345' })
  })

  it('平台开通必须带 operatorId', async () => {
    await expectReason('OPERATOR_REQUIRED', { source: 'PLATFORM' })
  })

  it('slug 被占用：只查了一次租户，什么都没建', async () => {
    const fake = createFakeTx({ takenSlugs: ['my-shop'] })
    expect(await expectReason('SLUG_TAKEN', {}, fake)).toEqual(['tenant.findUnique'])
  })
})

describe('provisionTenant / 店主账号', () => {
  it('新账号必须给口令', async () => {
    const fake = createFakeTx()
    expect(
      await expectReason('OWNER_PASSWORD_REQUIRED', { ownerPassword: undefined }, fake),
    ).toEqual(['tenant.findUnique', 'staffAccount.findUnique'])
  })

  it('新账号的口令要过强度', async () => {
    await expectReason('OWNER_PASSWORD_WEAK', { ownerPassword: '12345678' })
  })

  it('已有账号不给口令：拒绝（否则填个别人的手机号就能在他账号下开店）', async () => {
    const fake = createFakeTx({ accounts: [EXISTING_ACCOUNT] })
    expect(
      await expectReason('OWNER_PASSWORD_REQUIRED', { ownerPassword: undefined }, fake),
    ).toEqual(['tenant.findUnique', 'staffAccount.findUnique'])
  })

  it('已有账号口令不对：拒绝，且**一行都没建**', async () => {
    const fake = createFakeTx({ accounts: [EXISTING_ACCOUNT] })
    expect(
      await expectReason('OWNER_PASSWORD_MISMATCH', { ownerPassword: 'wrong-pass1' }, fake),
    ).toEqual(['tenant.findUnique', 'staffAccount.findUnique'])
  })

  it('已有账号被停用：拒绝', async () => {
    const fake = createFakeTx({ accounts: [{ ...EXISTING_ACCOUNT, status: 'DISABLED' }] })
    await expectReason('OWNER_ACCOUNT_DISABLED', {}, fake)
  })

  it('一号多店：口令对上就复用已有账号，不新建、不改口令、不改名', async () => {
    const fake = createFakeTx({ accounts: [EXISTING_ACCOUNT] })
    const result = await provisionTenant(fake.tx, BASE, createDeps())

    expect(result.created.account).toBe(false)
    expect(result.ownerAccountId).toBe('acc-old')
    expect(fake.seq()).not.toContain('staffAccount.create')
    expect(fake.payloads('tenant', 'create')[0]?.ownerAccountId).toBe('acc-old')
  })

  it('新账号：口令过一遍 hashPassword 才落库，且账号先于租户建', async () => {
    const fake = createFakeTx()
    const result = await provisionTenant(fake.tx, BASE, createDeps())

    expect(result.created.account).toBe(true)
    expect(fake.payloads('staffAccount', 'create')[0]).toEqual({
      id: 'id-1',
      phone: '13800000000',
      passwordHash: 'hash:abcd1234',
      name: '我的小店',
      status: 'ACTIVE',
    })
    expect(fake.seq().indexOf('staffAccount.create')).toBeLessThan(
      fake.seq().indexOf('tenant.create'),
    )
  })
})

describe('provisionTenant / 状态与到期', () => {
  it('默认是 TRIAL，试用到期落在**当天最后一刻** 23:59:59.999', async () => {
    const fake = createFakeTx()
    await provisionTenant(fake.tx, BASE, createDeps())

    const data = fake.payloads('tenant', 'create')[0]
    expect(data?.status).toBe('TRIAL')
    const trialEndAt = data?.trialEndAt as Date
    // 2026-03-01 + 14 天 = 2026-03-15 的 23:59:59.999（Asia/Shanghai）
    expect(trialEndAt.toISOString()).toBe('2026-03-15T15:59:59.999Z')
    expect(trialEndAt.getMilliseconds()).toBe(999)
    // 试用店的 planExpireAt 跟着试用到期走，别在平台后台的列表里显示成「无到期日」
    expect(data?.planExpireAt).toEqual(trialEndAt)
  })

  it('trialDays = 0：今天用完就到期，不是「立刻到期」', async () => {
    const fake = createFakeTx()
    await provisionTenant(fake.tx, { ...BASE, trialDays: 0 }, createDeps())
    expect((fake.payloads('tenant', 'create')[0]?.trialEndAt as Date).toISOString()).toBe(
      '2026-03-01T15:59:59.999Z',
    )
  })

  it('挂套餐 + 不给 trialDays = ACTIVE，trialEndAt 为空', async () => {
    const fake = createFakeTx()
    const planExpireAt = new Date('2027-03-01T15:59:59.999Z')
    await provisionTenant(
      fake.tx,
      { ...BASE, planId: 'plan-pro', planExpireAt, trialDays: undefined },
      createDeps(),
    )

    const data = fake.payloads('tenant', 'create')[0]
    expect(data?.status).toBe('ACTIVE')
    expect(data?.trialEndAt).toBeNull()
    expect(data?.planExpireAt).toEqual(planExpireAt)
    expect(data?.planId).toBe('plan-pro')
  })

  it('ACTIVE 却不给 planExpireAt：拒绝（闸门会算成未开通，开出来就是打烊的）', async () => {
    await expectReason('PLAN_EXPIRE_REQUIRED', { planId: 'plan-pro' })
  })

  it('挂着套餐也能试用：显式 trialDays 时仍是 TRIAL', async () => {
    const fake = createFakeTx()
    await provisionTenant(fake.tx, { ...BASE, planId: 'plan-pro', trialDays: 7 }, createDeps())
    const data = fake.payloads('tenant', 'create')[0]
    expect(data?.status).toBe('TRIAL')
    expect(data?.planId).toBe('plan-pro')
  })

  it('trialDays 非法：拒绝', async () => {
    await expectReason('TRIAL_DAYS_INVALID', { trialDays: -1 })
  })
})

describe('provisionTenant / 角色与成员', () => {
  it('内置模板整批复制进 Role，店主只拿 owner 那一个角色', async () => {
    const fake = createFakeTx()
    const result = await provisionTenant(fake.tx, BASE, createDeps())

    const roles = fake.payloads('role', 'create')
    expect(roles.map((row) => row.code)).toEqual(['manager', 'owner', 'staff'])
    expect(roles.every((row) => row.builtin === true)).toBe(true)
    expect(roles.find((row) => row.code === OWNER_ROLE_CODE)?.permissionCodes).toEqual(['*'])

    const staff = fake.payloads('staff', 'create')[0]
    expect(staff?.roleIds).toEqual([result.ownerRoleId])
    expect(staff?.isOwner).toBe(true)
    expect(staff?.dataScope).toBe('ALL')
    expect(result.ownerRoleId).toBe(roles.find((row) => row.code === 'owner')?.id)
  })

  it('DB 里没有模板时回落到 deps.rolePresets（只取 ADMIN 侧）', async () => {
    const fake = createFakeTx({ presets: [] })
    await provisionTenant(
      fake.tx,
      BASE,
      createDeps({
        rolePresets: [
          { code: 'owner', name: '店主', side: 'ADMIN', permissionCodes: ['*'] },
          { code: 'super', name: '平台超管', side: 'PLATFORM', permissionCodes: ['*'] },
        ],
      }),
    )
    expect(fake.payloads('role', 'create').map((row) => row.code)).toEqual(['owner'])
  })

  it('两边都没有模板：拒绝，而不是开出一个进去什么都点不了的租户', async () => {
    const fake = createFakeTx({ presets: [] })
    expect(await expectReason('ROLE_PRESET_EMPTY', {}, fake)).toEqual([
      'tenant.findUnique',
      'staffAccount.findUnique',
      'rolePreset.findMany',
    ])
  })

  it('模板里缺店主：拒绝', async () => {
    const fake = createFakeTx({ presets: FAKE_PRESETS.filter((row) => row.code !== 'owner') })
    expect(await expectReason('ROLE_PRESET_MISSING_OWNER', {}, fake)).toEqual([
      'tenant.findUnique',
      'staffAccount.findUnique',
      'rolePreset.findMany',
    ])
  })
})

describe('provisionTenant / 配额计数器', () => {
  it('给了 quotaCounter 就初始化，店主本人算进 STAFF 用量', async () => {
    const fake = createFakeTx({ quotaCounter: true })
    await provisionTenant(fake.tx, BASE, createDeps())

    const call = fake.calls.find((c) => c.model === 'quotaCounter')
    const rows = (call?.args as { data: Array<Record<string, unknown>> }).data
    expect(rows.map((row) => row.kind)).toEqual([
      'STAFF',
      'STORE',
      'MEMBER',
      'STORAGE_MB',
      'TRAFFIC_MB',
    ])
    expect(rows.find((row) => row.kind === 'STAFF')?.used).toBe(1)
    expect(rows.filter((row) => row.kind !== 'STAFF').every((row) => row.used === 0)).toBe(true)
  })

  it('没挂 quotaCounter 也能开通（nest-billing 第一次消耗时会自己建）', async () => {
    const fake = createFakeTx()
    await expect(provisionTenant(fake.tx, BASE, createDeps())).resolves.toBeTruthy()
    expect(fake.seq()).not.toContain('quotaCounter.createMany')
  })
})

describe('provisionTenant / 失败时不会部分创建', () => {
  it('建到第二个角色时炸掉：后面的 staff 与配额一步都没走', async () => {
    const fake = createFakeTx({
      quotaCounter: true,
      failAt: { model: 'role', method: 'create', nth: 2 },
    })
    await expect(provisionTenant(fake.tx, BASE, createDeps())).rejects.toThrow(/第 2 次失败/)

    expect(fake.seq()).toEqual([
      'tenant.findUnique',
      'staffAccount.findUnique',
      'rolePreset.findMany',
      'staffAccount.create',
      'tenant.create',
      'role.create',
      'role.create',
    ])
  })

  it('建租户那一步炸掉：角色与成员都没建', async () => {
    const fake = createFakeTx({ failAt: { model: 'tenant', method: 'create' } })
    await expect(provisionTenant(fake.tx, BASE, createDeps())).rejects.toThrow()
    expect(fake.seq()).not.toContain('role.create')
    expect(fake.seq()).not.toContain('staff.create')
  })
})

describe('provisionTenant / 建租户只有一条路', () => {
  it('PLATFORM 与 SIGNUP 的调用序列**逐字节相同**', async () => {
    const signup = createFakeTx({ quotaCounter: true })
    await provisionTenant(signup.tx, { ...BASE, source: 'SIGNUP' }, createDeps())

    const platform = createFakeTx({ quotaCounter: true })
    await provisionTenant(
      platform.tx,
      { ...BASE, source: 'PLATFORM', operatorId: 'admin-1' },
      createDeps(),
    )

    expect(platform.calls).toEqual(signup.calls)
  })

  it('IMPORT 也一样', async () => {
    const signup = createFakeTx()
    await provisionTenant(signup.tx, { ...BASE, source: 'SIGNUP' }, createDeps())
    const imported = createFakeTx()
    await provisionTenant(imported.tx, { ...BASE, source: 'IMPORT' }, createDeps())
    expect(imported.calls).toEqual(signup.calls)
  })

  it('source 与 operatorId 不出现在任何写库载荷里', async () => {
    const fake = createFakeTx({ quotaCounter: true })
    await provisionTenant(
      fake.tx,
      { ...BASE, source: 'PLATFORM', operatorId: 'admin-1' },
      createDeps(),
    )
    const dump = JSON.stringify(fake.calls)
    expect(dump).not.toContain('PLATFORM')
    expect(dump).not.toContain('admin-1')
  })

  it('产出的结果指向真的建出来的那几行', async () => {
    const fake = createFakeTx()
    const result = await provisionTenant(fake.tx, BASE, createDeps())

    expect(result.tenantId).toBe(fake.payloads('tenant', 'create')[0]?.id)
    expect(result.ownerAccountId).toBe(fake.payloads('staffAccount', 'create')[0]?.id)
    expect(result.ownerStaffId).toBe(fake.payloads('staff', 'create')[0]?.id)
    // 不下发 token：结果里连个 token 字段都不该有（注册接口不是登录口）
    expect(Object.keys(result).sort()).toEqual([
      'attachedExistingAccount',
      'created',
      'ownerAccountId',
      'ownerRoleId',
      'ownerStaffId',
      'tenantId',
    ])
    expect(result.attachedExistingAccount).toBe(false)
  })
})

describe('buildProvisionAudit', () => {
  it('两条路的差别**只在审计里**：actorId、source，action 恒为两段式 tenant.create', async () => {
    const fake = createFakeTx()
    const input: ProvisionInput = { ...BASE, source: 'PLATFORM', operatorId: 'admin-1' }
    const result = await provisionTenant(fake.tx, input, createDeps())

    expect(buildProvisionAudit(input, result)).toEqual({
      action: 'tenant.create',
      targetTenantId: result.tenantId,
      targetType: 'Tenant',
      targetId: result.tenantId,
      actorId: 'admin-1',
      after: {
        slug: 'my-shop',
        name: '我的小店',
        source: 'PLATFORM',
        planId: null,
        ownerAccountId: result.ownerAccountId,
        accountCreated: true,
      },
    })
  })

  it('自助注册没有操作者：记成新店主自己，action 仍是 tenant.create', async () => {
    const fake = createFakeTx()
    const result = await provisionTenant(fake.tx, BASE, createDeps())
    const audit = buildProvisionAudit(BASE, result)
    expect(audit.action).toBe('tenant.create')
    expect(audit.actorId).toBe(result.ownerAccountId)
  })

  it('action 是 module.action 两段式：恰好一个点，不含 source', () => {
    const ACTION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9]+(-[a-z0-9]+)*$/
    for (const action of ['tenant.create', 'tenant.create-attach-existing']) {
      expect(action).toMatch(ACTION_PATTERN)
    }
  })

  it('attachExistingAccount 生效时：action 换成 tenant.create-attach-existing，after 里带上标记', async () => {
    const fake = createFakeTx({ accounts: [EXISTING_ACCOUNT] })
    const input: ProvisionInput = {
      ...BASE,
      ownerPassword: undefined,
      source: 'PLATFORM',
      operatorId: 'admin-1',
      attachExistingAccount: true,
    }
    const result = await provisionTenant(fake.tx, input, createDeps())

    expect(buildProvisionAudit(input, result)).toEqual({
      action: 'tenant.create-attach-existing',
      targetTenantId: result.tenantId,
      targetType: 'Tenant',
      targetId: result.tenantId,
      actorId: 'admin-1',
      after: {
        slug: 'my-shop',
        name: '我的小店',
        source: 'PLATFORM',
        planId: null,
        ownerAccountId: result.ownerAccountId,
        accountCreated: false,
        attachedExistingAccount: true,
      },
    })
  })
})

describe('provisionTenant / attachExistingAccount（平台后台绑定既有账号）', () => {
  it('SIGNUP 传 true：拒绝，且**一次库都没查**', async () => {
    const fake = createFakeTx()
    expect(
      await expectReason(
        'ATTACH_NOT_ALLOWED',
        { source: 'SIGNUP', attachExistingAccount: true },
        fake,
      ),
    ).toEqual([])
  })

  it('IMPORT 传 true：拒绝，且**一次库都没查**', async () => {
    const fake = createFakeTx()
    expect(
      await expectReason(
        'ATTACH_NOT_ALLOWED',
        { source: 'IMPORT', attachExistingAccount: true },
        fake,
      ),
    ).toEqual([])
  })

  it('PLATFORM 传 true 但没有 operatorId：按 OPERATOR_REQUIRED 拒绝（不是 ATTACH_NOT_ALLOWED）', async () => {
    await expectReason('OPERATOR_REQUIRED', {
      source: 'PLATFORM',
      operatorId: undefined,
      attachExistingAccount: true,
    })
  })

  it('账号不存在：拒绝（不会退化成拿占位口令建新账号），只查过一次账号', async () => {
    const fake = createFakeTx()
    expect(
      await expectReason(
        'ATTACH_ACCOUNT_NOT_FOUND',
        {
          source: 'PLATFORM',
          operatorId: 'admin-1',
          ownerPassword: undefined,
          attachExistingAccount: true,
        },
        fake,
      ),
    ).toEqual(['tenant.findUnique', 'staffAccount.findUnique'])
  })

  it('账号已停用：拒绝', async () => {
    const fake = createFakeTx({ accounts: [{ ...EXISTING_ACCOUNT, status: 'DISABLED' }] })
    await expectReason(
      'OWNER_ACCOUNT_DISABLED',
      {
        source: 'PLATFORM',
        operatorId: 'admin-1',
        ownerPassword: undefined,
        attachExistingAccount: true,
      },
      fake,
    )
  })

  it('账号存在：跳过 verifyPassword，即便完全不给口令也能成功', async () => {
    let verifyCalled = false
    const fake = createFakeTx({ accounts: [EXISTING_ACCOUNT] })
    const deps = createDeps({
      verifyPassword: () => {
        verifyCalled = true
        return false // 就算回 false，也不该被调用——本用例断言的正是"没调用"
      },
    })
    const result = await provisionTenant(
      fake.tx,
      {
        ...BASE,
        ownerPassword: undefined,
        source: 'PLATFORM',
        operatorId: 'admin-1',
        attachExistingAccount: true,
      },
      deps,
    )

    expect(verifyCalled).toBe(false)
    expect(result.attachedExistingAccount).toBe(true)
    expect(result.created.account).toBe(false)
    expect(result.ownerAccountId).toBe('acc-old')
    expect(fake.seq()).not.toContain('staffAccount.create')
  })

  it('tx 调用序列与「不 attach、口令对上」的一号多店复用完全一样——attach 只跳过 verifyPassword，不改任何写库调用', async () => {
    const normal = createFakeTx({ accounts: [EXISTING_ACCOUNT], quotaCounter: true })
    await provisionTenant(normal.tx, BASE, createDeps())

    const attached = createFakeTx({ accounts: [EXISTING_ACCOUNT], quotaCounter: true })
    await provisionTenant(
      attached.tx,
      {
        ...BASE,
        ownerPassword: undefined,
        source: 'PLATFORM',
        operatorId: 'admin-1',
        attachExistingAccount: true,
      },
      createDeps(),
    )

    expect(attached.calls).toEqual(normal.calls)
  })

  it('source 与 operatorId 依然不出现在任何写库载荷里', async () => {
    const fake = createFakeTx({ accounts: [EXISTING_ACCOUNT], quotaCounter: true })
    await provisionTenant(
      fake.tx,
      {
        ...BASE,
        ownerPassword: undefined,
        source: 'PLATFORM',
        operatorId: 'admin-1',
        attachExistingAccount: true,
      },
      createDeps(),
    )
    const dump = JSON.stringify(fake.calls)
    expect(dump).not.toContain('PLATFORM')
    expect(dump).not.toContain('admin-1')
  })

  it('不给 attachExistingAccount（或给 false）：行为与之前完全一样，attachedExistingAccount 回 false', async () => {
    const fake = createFakeTx({ accounts: [EXISTING_ACCOUNT] })
    const result = await provisionTenant(
      fake.tx,
      { ...BASE, source: 'PLATFORM', operatorId: 'admin-1', attachExistingAccount: false },
      createDeps(),
    )
    expect(result.attachedExistingAccount).toBe(false)
  })
})
