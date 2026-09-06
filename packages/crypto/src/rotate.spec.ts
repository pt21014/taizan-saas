import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EncryptedColumn } from './columns'
import { UnknownKeyIdError } from './errors'
import {
  executeRotation,
  formatRotationPlan,
  formatRotationResult,
  planRotation,
  RotationPlanError,
  type RotationIo,
  type RotationRow,
} from './rotate'
import { createVault, type CredentialVault } from './vault'

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)

/** 三列，形状照抄 `@taizan/prisma-base` 的 ENCRYPTED_COLUMNS。 */
const TENANT_CRED: EncryptedColumn = {
  model: 'TenantCredential',
  column: 'valueEnc',
  keyIdColumn: 'keyId',
  description: '租户级三方密钥',
}
const PLATFORM_SETTING: EncryptedColumn = {
  model: 'PlatformSetting',
  column: 'valueEnc',
  keyIdColumn: 'keyId',
  description: '平台级密钥',
}
const PLATFORM_ADMIN: EncryptedColumn = {
  model: 'PlatformAdmin',
  column: 'mfaSecretEnc',
  keyIdColumn: 'mfaKeyId',
  description: 'TOTP 种子',
}

const REGISTRY: EncryptedColumn[] = [TENANT_CRED, PLATFORM_SETTING, PLATFORM_ADMIN]

/** 内存版 io：一张 model → 行数组的表，行为按 {@link RotationIo} 的约定实现。 */
class MemoryIo implements RotationIo {
  readonly tables = new Map<string, RotationRow[]>()
  readonly updates: { model: string; id: string; patch: Record<string, string> }[] = []

  seed(model: string, rows: RotationRow[]): void {
    this.tables.set(model, rows)
  }

  listRows(
    model: string,
    _column: string,
    keyIdColumn: string,
    query: { keyId: string; cursor?: string; limit: number },
  ): RotationRow[] {
    const rows = this.tables.get(model) ?? []
    return rows
      .filter((r) => r[keyIdColumn] === query.keyId)
      .filter((r) => (query.cursor === undefined ? true : r.id > query.cursor))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, query.limit)
  }

  updateRow(model: string, id: string, patch: Record<string, string>): void {
    const row = (this.tables.get(model) ?? []).find((r) => r.id === id)
    if (!row) throw new Error(`内存 io 里没有 ${model}#${id}`)
    Object.assign(row, patch)
    this.updates.push({ model, id, patch })
  }
}

function makeVault(currentKeyId = 'k1'): CredentialVault {
  return createVault({ keys: { k1: K1, k2: K2 }, currentKeyId })
}

/** 造一份含「已是 k2 的行」与「损坏行」的三张表。 */
function seedAll(io: MemoryIo, vault: CredentialVault): void {
  const enc = (plain: string, keyId: string) => vault.encryptWith(plain, keyId).valueEnc

  io.seed('TenantCredential', [
    { id: 't01', valueEnc: enc('wx-secret-1', 'k1'), keyId: 'k1' },
    { id: 't02', valueEnc: enc('wx-secret-2', 'k1'), keyId: 'k1' },
    // 已经轮换过的行：不该被再碰一次
    { id: 't03', valueEnc: enc('wx-secret-3', 'k2'), keyId: 'k2' },
    // 损坏行：标着 k1，内容却是历史明文
    { id: 't04', valueEnc: 'legacy-plaintext-secret', keyId: 'k1' },
    // 空值行：跳过
    { id: 't05', valueEnc: '', keyId: 'k1' },
  ])

  io.seed('PlatformSetting', [
    { id: 'p01', valueEnc: enc('platform-key', 'k1'), keyId: 'k1' },
    { id: 'p02', valueEnc: null, keyId: 'k1' },
  ])

  io.seed('PlatformAdmin', [
    { id: 'a01', mfaSecretEnc: enc('TOTPSEED1', 'k1'), mfaKeyId: 'k1' },
    { id: 'a02', mfaSecretEnc: enc('TOTPSEED2', 'k1'), mfaKeyId: 'k1' },
    // 损坏行：密文被截断
    { id: 'a03', mfaSecretEnc: enc('TOTPSEED3', 'k1').slice(0, -4), mfaKeyId: 'k1' },
  ])
}

describe('planRotation', () => {
  it('不给 only 时一列一条，顺序同注册表', () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', { dryRun: false })
    expect(plan.items.map((i) => i.ref)).toEqual([
      'TenantCredential.valueEnc',
      'PlatformSetting.valueEnc',
      'PlatformAdmin.mfaSecretEnc',
    ])
    expect(plan.filteredOut).toEqual([])
  })

  it('计划里带上了 keyIdColumn 与 description', () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', { dryRun: true })
    const item = plan.items.find((i) => i.model === 'PlatformAdmin')
    expect(item?.keyIdColumn).toBe('mfaKeyId')
    expect(item?.description).toBe('TOTP 种子')
  })

  it('only 支持 Model.column 过滤', () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', {
      dryRun: true,
      only: ['TenantCredential.valueEnc'],
    })
    expect(plan.items.map((i) => i.ref)).toEqual(['TenantCredential.valueEnc'])
    expect(plan.filteredOut).toEqual(['PlatformSetting.valueEnc', 'PlatformAdmin.mfaSecretEnc'])
  })

  it('only 支持逗号分隔与重复传入', () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', {
      dryRun: true,
      only: ['TenantCredential.valueEnc,PlatformSetting.valueEnc'],
    })
    expect(plan.items).toHaveLength(2)
  })

  it('only 里混着一个不存在的列名：能匹配的照跑，不存在的进 unmatchedOnly', () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', {
      dryRun: true,
      only: ['TenantCredential.valueEnc', 'Nope.valueEnc'],
    })
    expect(plan.items).toHaveLength(1)
    expect(plan.unmatchedOnly).toEqual(['Nope.valueEnc'])
  })

  it('only 一个都匹配不上时抛 RotationPlanError（列名打错不该被当成「没什么可换」）', () => {
    expect(() =>
      planRotation(REGISTRY, 'k1', 'k2', { dryRun: true, only: ['Nope.valueEnc'] }),
    ).toThrow(RotationPlanError)
  })

  it('from 与 to 相同时抛错', () => {
    expect(() => planRotation(REGISTRY, 'k1', 'k1', { dryRun: true })).toThrow(/不是轮换/)
  })

  it('from 或 to 为空时抛错', () => {
    expect(() => planRotation(REGISTRY, '', 'k2', { dryRun: true })).toThrow(RotationPlanError)
    expect(() => planRotation(REGISTRY, 'k1', '', { dryRun: true })).toThrow(RotationPlanError)
  })

  it('dryRun 原样带进计划', () => {
    expect(planRotation(REGISTRY, 'k1', 'k2', { dryRun: true }).dryRun).toBe(true)
    expect(planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }).dryRun).toBe(false)
  })

  it('formatRotationPlan 打出中文计划并标注 dry-run', () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', {
      dryRun: true,
      only: ['TenantCredential.valueEnc', 'Nope.x'],
    })
    const text = formatRotationPlan(plan).join('\n')
    expect(text).toContain('k1 → k2')
    expect(text).toContain('--dry-run')
    expect(text).toContain('TenantCredential.valueEnc')
    expect(text).toContain('Nope.x')
  })
})

describe('executeRotation', () => {
  let io: MemoryIo
  let vault: CredentialVault

  beforeEach(() => {
    vault = makeVault('k2')
    io = new MemoryIo()
    seedAll(io, vault)
  })

  it('dryRun 时一次 updateRow 都不调', async () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', { dryRun: true })
    const spy = vi.spyOn(io, 'updateRow')
    const result = await executeRotation(plan, vault, io)
    expect(spy).not.toHaveBeenCalled()
    expect(result.rotated).toBeGreaterThan(0)
    expect(io.updates).toHaveLength(0)
  })

  it('dryRun 的统计与真跑一致', async () => {
    const dry = await executeRotation(
      planRotation(REGISTRY, 'k1', 'k2', { dryRun: true }),
      vault,
      io,
    )
    const wet = await executeRotation(
      planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }),
      vault,
      io,
    )
    expect(wet.scanned).toBe(dry.scanned)
    expect(wet.rotated).toBe(dry.rotated)
    expect(wet.failed).toHaveLength(dry.failed.length)
  })

  it('真跑一遍：可解的行都换到 k2，且能用新 keyId 解回原文', async () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', { dryRun: false })
    const result = await executeRotation(plan, vault, io)
    expect(result.rotated).toBe(5) // t01 t02 p01 a01 a02
    const t01 = io.tables.get('TenantCredential')!.find((r) => r.id === 't01')!
    expect(t01.keyId).toBe('k2')
    expect(vault.decrypt(t01.valueEnc as string, 'k2')).toBe('wx-secret-1')
  })

  it('写回时密文与 keyId 在同一条 patch 里（分两次写会留下解不开的行）', async () => {
    await executeRotation(planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }), vault, io)
    for (const u of io.updates) {
      expect(Object.keys(u.patch).length).toBe(2)
    }
    const patch = io.updates.find((u) => u.model === 'PlatformAdmin')!.patch
    expect(Object.keys(patch).sort()).toEqual(['mfaKeyId', 'mfaSecretEnc'])
    expect(patch.mfaKeyId).toBe('k2')
  })

  it('已经是 to 的行不被再碰一次', async () => {
    const before = io.tables.get('TenantCredential')!.find((r) => r.id === 't03')!.valueEnc
    await executeRotation(planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }), vault, io)
    const after = io.tables.get('TenantCredential')!.find((r) => r.id === 't03')!.valueEnc
    expect(after).toBe(before)
    expect(io.updates.some((u) => u.id === 't03')).toBe(false)
  })

  it('空值行与 null 行被跳过而不是记失败', async () => {
    const result = await executeRotation(
      planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }),
      vault,
      io,
    )
    expect(result.skipped).toBe(2) // t05 空串 + p02 null
    expect(result.failed.map((f) => f.id)).not.toContain('t05')
  })

  it('损坏行进 failed 并带上 ref 与 id，其余行照常换完', async () => {
    const result = await executeRotation(
      planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }),
      vault,
      io,
    )
    expect(result.failed.map((f) => f.id).sort()).toEqual(['a03', 't04'])
    expect(result.failed.find((f) => f.id === 't04')?.ref).toBe('TenantCredential.valueEnc')
    // 失败的行不被改动
    const t04 = io.tables.get('TenantCredential')!.find((r) => r.id === 't04')!
    expect(t04.keyId).toBe('k1')
    expect(t04.valueEnc).toBe('legacy-plaintext-secret')
  })

  it('failed 的 reason 里不含明文/密文', async () => {
    const result = await executeRotation(
      planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }),
      vault,
      io,
    )
    for (const f of result.failed) {
      expect(f.reason).not.toContain('legacy-plaintext-secret')
      expect(f.reason).not.toContain('v1:')
    }
  })

  it('幂等：重复跑第二次改动数为 0', async () => {
    const plan = () => planRotation(REGISTRY, 'k1', 'k2', { dryRun: false })
    const first = await executeRotation(plan(), vault, io)
    expect(first.rotated).toBe(5)
    io.updates.length = 0

    const second = await executeRotation(plan(), vault, io)
    expect(second.rotated).toBe(0)
    expect(io.updates).toHaveLength(0)
    // 第二次仍会扫到那两行损坏行（它们的 keyId 还停在 k1）
    expect(second.failed.map((f) => f.id).sort()).toEqual(['a03', 't04'])
  })

  it('第三次跑依然是 0 改动（幂等不止一次）', async () => {
    const plan = () => planRotation(REGISTRY, 'k1', 'k2', { dryRun: false })
    await executeRotation(plan(), vault, io)
    await executeRotation(plan(), vault, io)
    io.updates.length = 0
    const third = await executeRotation(plan(), vault, io)
    expect(third.rotated).toBe(0)
    expect(io.updates).toHaveLength(0)
  })

  it('perColumn 明细按列拆开，三列都在', async () => {
    const result = await executeRotation(
      planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }),
      vault,
      io,
    )
    expect(result.perColumn.map((p) => p.ref)).toEqual([
      'TenantCredential.valueEnc',
      'PlatformSetting.valueEnc',
      'PlatformAdmin.mfaSecretEnc',
    ])
    const tenant = result.perColumn[0]
    expect(tenant).toMatchObject({ scanned: 4, rotated: 2, skipped: 1, failed: 1 })
  })

  it('onColumnDone 每列回调一次', async () => {
    const seen: string[] = []
    await executeRotation(planRotation(REGISTRY, 'k1', 'k2', { dryRun: true }), vault, io, {
      onColumnDone: (r) => seen.push(r.ref),
    })
    expect(seen).toHaveLength(3)
  })

  it('小 batchSize 也能翻完全部页（分页边界）', async () => {
    const result = await executeRotation(
      planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }),
      vault,
      io,
      { batchSize: 1 },
    )
    expect(result.rotated).toBe(5)
  })

  it('batchSize 非正整数抛 RangeError', async () => {
    await expect(
      executeRotation(planRotation(REGISTRY, 'k1', 'k2', { dryRun: true }), vault, io, {
        batchSize: 0,
      }),
    ).rejects.toThrow(RangeError)
  })

  it('only 过滤后只动那一列', async () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', {
      dryRun: false,
      only: ['PlatformAdmin.mfaSecretEnc'],
    })
    await executeRotation(plan, vault, io)
    expect(io.updates.every((u) => u.model === 'PlatformAdmin')).toBe(true)
    expect(io.tables.get('TenantCredential')!.find((r) => r.id === 't01')!.keyId).toBe('k1')
  })

  it('from 不在密钥表里时开跑前就抛，不会跑一半才炸', async () => {
    const plan = planRotation(REGISTRY, 'k9', 'k2', { dryRun: false })
    const spy = vi.spyOn(io, 'listRows')
    await expect(executeRotation(plan, vault, io)).rejects.toThrow(UnknownKeyIdError)
    expect(spy).not.toHaveBeenCalled()
  })

  it('to 不在密钥表里时同样开跑前就抛', async () => {
    const plan = planRotation(REGISTRY, 'k1', 'k9', { dryRun: false })
    await expect(executeRotation(plan, vault, io)).rejects.toThrow(UnknownKeyIdError)
  })

  it('io 不推进游标时抛错而不是死循环', async () => {
    const stuck: RotationIo = {
      listRows: () => [{ id: 'same', valueEnc: '', keyId: 'k1' }],
      updateRow: () => undefined,
    }
    const plan = planRotation([TENANT_CRED], 'k1', 'k2', { dryRun: false })
    // batchSize=1 让每批都是满的，逼出「翻下一页」的分支
    await expect(executeRotation(plan, vault, stuck, { batchSize: 1 })).rejects.toThrow(
      /没有推进游标/,
    )
  })

  it('io 返回了 keyId 不是 from 的行时跳过而不是误改', async () => {
    const liar: RotationIo = {
      listRows: (_m, _c, _k, q) =>
        q.cursor ? [] : [{ id: 'x1', valueEnc: 'whatever', keyId: 'k2' }],
      updateRow: () => {
        throw new Error('不该被调用')
      },
    }
    const plan = planRotation([TENANT_CRED], 'k1', 'k2', { dryRun: false })
    const result = await executeRotation(plan, vault, liar)
    expect(result.skipped).toBe(1)
    expect(result.rotated).toBe(0)
  })

  it('支持异步 io（真 Prisma 是异步的）', async () => {
    const asyncIo: RotationIo = {
      listRows: async (m, c, k, q) => Promise.resolve(io.listRows(m, c, k, q)),
      updateRow: async (m, id, patch) => Promise.resolve(io.updateRow(m, id, patch)),
    }
    const result = await executeRotation(
      planRotation(REGISTRY, 'k1', 'k2', { dryRun: false }),
      vault,
      asyncIo,
    )
    expect(result.rotated).toBe(5)
  })

  it('formatRotationResult 打中文统计与失败明细', async () => {
    const plan = planRotation(REGISTRY, 'k1', 'k2', { dryRun: false })
    const result = await executeRotation(plan, vault, io)
    const text = formatRotationResult(plan, result).join('\n')
    expect(text).toContain('已轮换 5 行')
    expect(text).toContain('t04')
    expect(text).not.toContain('legacy-plaintext-secret')
  })

  it('第二次跑的输出里点明「这正是幂等的预期结果」', async () => {
    const plan = () => planRotation([PLATFORM_SETTING], 'k1', 'k2', { dryRun: false })
    await executeRotation(plan(), vault, io)
    const p = plan()
    const text = formatRotationResult(p, await executeRotation(p, vault, io)).join('\n')
    expect(text).toContain('幂等')
  })
})
