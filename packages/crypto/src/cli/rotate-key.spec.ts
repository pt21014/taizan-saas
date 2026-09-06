import { describe, expect, it } from 'vitest'

import type { EncryptedColumn } from '../columns'
import type { RotationIo, RotationRow } from '../rotate'
import { createVault } from '../vault'
import { parseArgs, runRotateKeyCli, usageLines } from './rotate-key'

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const ENV = { CRYPTO_KEYS: JSON.stringify({ k1: K1, k2: K2 }), CRYPTO_KEY_CURRENT: 'k2' }

const COLUMNS: EncryptedColumn[] = [
  { model: 'TenantCredential', column: 'valueEnc', keyIdColumn: 'keyId', description: '租户密钥' },
  { model: 'PlatformAdmin', column: 'mfaSecretEnc', keyIdColumn: 'mfaKeyId' },
]

/** 造一个假 adapter 模块（`--adapter` 会 import 出来的东西）。 */
function fakeAdapter() {
  const vault = createVault({ keys: { k1: K1, k2: K2 }, currentKeyId: 'k2' })
  const tables = new Map<string, RotationRow[]>([
    [
      'TenantCredential',
      [
        { id: 't01', valueEnc: vault.encryptWith('s1', 'k1').valueEnc, keyId: 'k1' },
        { id: 't02', valueEnc: 'legacy-plaintext', keyId: 'k1' },
      ],
    ],
    [
      'PlatformAdmin',
      [{ id: 'a01', mfaSecretEnc: vault.encryptWith('seed', 'k1').valueEnc, mfaKeyId: 'k1' }],
    ],
  ])
  const updates: string[] = []
  const io: RotationIo & { columns: EncryptedColumn[] } = {
    columns: COLUMNS,
    listRows(model, _column, keyIdColumn, query) {
      return (tables.get(model) ?? [])
        .filter((r) => r[keyIdColumn] === query.keyId)
        .filter((r) => (query.cursor === undefined ? true : r.id > query.cursor))
        .slice(0, query.limit)
    },
    updateRow(model, id, patch) {
      const row = (tables.get(model) ?? []).find((r) => r.id === id)!
      Object.assign(row, patch)
      updates.push(`${model}#${id}`)
    },
  }
  return { io, updates, tables }
}

/** 跑一次 CLI，把输出收集成数组。 */
async function run(
  argv: string[],
  opts: { mod?: unknown; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; out: string[]; text: string }> {
  const out: string[] = []
  const code = await runRotateKeyCli(argv, {
    write: (line) => out.push(line),
    env: opts.env ?? ENV,
    importer: async () => opts.mod,
  })
  return { code, out, text: out.join('\n') }
}

describe('parseArgs', () => {
  it('解析 --from / --to / --dry-run', () => {
    const args = parseArgs(['--from=k1', '--to=k2', '--dry-run'])
    expect(args).toMatchObject({ from: 'k1', to: 'k2', dryRun: true })
  })

  it('--only 可重复', () => {
    expect(parseArgs(['--only=A.b', '--only=C.d']).only).toEqual(['A.b', 'C.d'])
  })

  it('--adapter 与 --registry 解析出来', () => {
    const args = parseArgs(['--adapter=./a.js', '--registry=./r.js'])
    expect(args.adapter).toBe('./a.js')
    expect(args.registry).toBe('./r.js')
  })

  it('-h 与 --help 都算 help', () => {
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
  })

  it('认不出的参数进 unknown 而不是被静默吞掉', () => {
    expect(parseArgs(['--force', 'oops']).unknown).toEqual(['--force', 'oops'])
  })

  it('--from= 空值也解析成空串（由 CLI 再判合法性）', () => {
    expect(parseArgs(['--from=']).from).toBe('')
  })
})

describe('runRotateKeyCli 无 adapter', () => {
  it('--from/--to/--dry-run 但没给 adapter：打印说明并退出 0', async () => {
    const { code, text } = await run(['--from=k1', '--to=k2', '--dry-run'])
    expect(code).toBe(0)
    expect(text).toContain('没有给 --adapter')
    expect(text).toContain('k1 → k2')
    expect(text).toContain('taizan-rotate-key')
  })

  it('没有 adapter 时不需要 CRYPTO_KEYS 也能跑（只是看说明）', async () => {
    const { code } = await run(['--from=k1', '--to=k2'], { env: {} })
    expect(code).toBe(0)
  })

  it('--help 打印用法并退出 0', async () => {
    const { code, text } = await run(['--help'])
    expect(code).toBe(0)
    expect(text).toContain('用法：')
    expect(text).toContain('--only=A.b')
  })

  it('用法里写清了「旧 keyId 换完前不要删」', async () => {
    expect(usageLines().join('\n')).toContain('不要把旧 keyId')
  })

  it('缺 --from 时退出码 2', async () => {
    const { code, text } = await run(['--to=k2'])
    expect(code).toBe(2)
    expect(text).toContain('缺少 --from')
  })

  it('认不出的参数退出码 2', async () => {
    const { code, text } = await run(['--from=k1', '--to=k2', '--force'])
    expect(code).toBe(2)
    expect(text).toContain('--force')
  })
})

describe('runRotateKeyCli 带 adapter', () => {
  it('dry-run 打印计划与统计，但一行都不写', async () => {
    const { io, updates } = fakeAdapter()
    const { code, text } = await run(['--from=k1', '--to=k2', '--dry-run', '--adapter=./fake.js'], {
      mod: { default: io },
    })
    expect(code).toBe(1) // 有一行历史明文解不开
    expect(text).toContain('轮换计划')
    expect(text).toContain('--dry-run，不写库')
    expect(updates).toEqual([])
  })

  it('真跑：换掉可解的行，退出码按 failed 决定', async () => {
    const { io, updates } = fakeAdapter()
    const { code, text } = await run(['--from=k1', '--to=k2', '--adapter=./fake.js'], {
      mod: { default: io },
    })
    expect(updates.sort()).toEqual(['PlatformAdmin#a01', 'TenantCredential#t01'])
    expect(text).toContain('已轮换 2 行')
    expect(code).toBe(1) // t02 是历史明文
  })

  it('全部成功时退出码 0', async () => {
    const { io } = fakeAdapter()
    const { code } = await run(
      ['--from=k1', '--to=k2', '--only=PlatformAdmin.mfaSecretEnc', '--adapter=./fake.js'],
      { mod: { default: io } },
    )
    expect(code).toBe(0)
  })

  it('幂等：连跑两次，第二次没有任何写入', async () => {
    const { io, updates } = fakeAdapter()
    const mod = { default: io }
    await run(['--from=k1', '--to=k2', '--adapter=./fake.js'], { mod })
    updates.length = 0
    const { text } = await run(['--from=k1', '--to=k2', '--adapter=./fake.js'], { mod })
    expect(updates).toEqual([])
    expect(text).toContain('已轮换 0 行')
  })

  it('--only 过滤后计划里只剩一列', async () => {
    const { io } = fakeAdapter()
    const { text } = await run(
      ['--from=k1', '--to=k2', '--dry-run', '--only=TenantCredential.valueEnc', '--adapter=./f.js'],
      { mod: { default: io } },
    )
    expect(text).toContain('待处理列 1 个')
    expect(text).toContain('被 --only 过滤掉')
  })

  it('--only 写错列名时退出码 2 并列出可选列', async () => {
    const { io } = fakeAdapter()
    const { code, text } = await run(
      ['--from=k1', '--to=k2', '--only=Nope.valueEnc', '--adapter=./f.js'],
      { mod: { default: io } },
    )
    expect(code).toBe(2)
    expect(text).toContain('TenantCredential.valueEnc')
  })

  it('adapter 具名导出 io 也认', async () => {
    const { io } = fakeAdapter()
    const { code } = await run(['--from=k1', '--to=k2', '--dry-run', '--adapter=./f.js'], {
      mod: { io },
    })
    expect(code).toBe(1)
  })

  it('adapter 导出工厂函数 createRotationIo 也认', async () => {
    const { io } = fakeAdapter()
    const { code, text } = await run(['--from=k1', '--to=k2', '--dry-run', '--adapter=./f.js'], {
      mod: { createRotationIo: () => io },
    })
    expect(code).toBe(1)
    expect(text).toContain('轮换计划')
  })

  it('adapter 里没有 listRows/updateRow 时报错并退出 1', async () => {
    const { code, text } = await run(['--from=k1', '--to=k2', '--adapter=./f.js'], {
      mod: { default: {} },
    })
    expect(code).toBe(1)
    expect(text).toContain('listRows')
  })

  it('adapter 没带 columns 且没给 --registry 时退出 2', async () => {
    const { io } = fakeAdapter()
    const bare = { listRows: io.listRows, updateRow: io.updateRow }
    const { code, text } = await run(['--from=k1', '--to=k2', '--adapter=./f.js'], {
      mod: { default: bare },
    })
    expect(code).toBe(2)
    expect(text).toContain('注册表')
  })

  it('--registry 指的模块可以单独提供注册表', async () => {
    const { io } = fakeAdapter()
    const bare = { listRows: io.listRows, updateRow: io.updateRow }
    const out: string[] = []
    const code = await runRotateKeyCli(
      ['--from=k1', '--to=k2', '--dry-run', '--adapter=./a.js', '--registry=./r.js'],
      {
        write: (l) => out.push(l),
        env: ENV,
        importer: async (spec) =>
          spec.includes('r.js') ? { ENCRYPTED_COLUMNS: COLUMNS } : { default: bare },
      },
    )
    expect(out.join('\n')).toContain('待处理列 2 个')
    expect(code).toBe(1)
  })

  it('keyIdColumn 与命名规则推导不一致时给出提示（以注册表为准）', async () => {
    const { io } = fakeAdapter()
    const weird = {
      ...io,
      columns: [{ model: 'Thing', column: 'tokenEnc', keyIdColumn: 'weirdKey' }],
    }
    const { text } = await run(['--from=k1', '--to=k2', '--dry-run', '--adapter=./f.js'], {
      mod: { default: weird },
    })
    expect(text).toContain('以注册表为准')
    expect(text).toContain('tokenKeyId')
  })

  it('缺 CRYPTO_KEYS 时报错且不回显任何密钥', async () => {
    const { io } = fakeAdapter()
    const { code, text } = await run(['--from=k1', '--to=k2', '--adapter=./f.js'], {
      mod: { default: io },
      env: {},
    })
    expect(code).toBe(1)
    expect(text).toContain('CRYPTO_KEYS')
    expect(text).not.toContain(K1)
  })

  it('CRYPTO_KEYS 不是合法 JSON 时报错且不回显原文', async () => {
    const { io } = fakeAdapter()
    const { code, text } = await run(['--from=k1', '--to=k2', '--adapter=./f.js'], {
      mod: { default: io },
      env: { CRYPTO_KEYS: 'not-json-but-secret', CRYPTO_KEY_CURRENT: 'k1' },
    })
    expect(code).toBe(1)
    expect(text).not.toContain('not-json-but-secret')
  })

  it('CRYPTO_KEYS 里缺 --from 那把密钥时报错', async () => {
    const { io } = fakeAdapter()
    const { code, text } = await run(['--from=k9', '--to=k2', '--adapter=./f.js'], {
      mod: { default: io },
    })
    expect(code).toBe(1)
    expect(text).toContain('k9')
  })

  it('输出里不含任何明文或密文', async () => {
    const { io } = fakeAdapter()
    const { text } = await run(['--from=k1', '--to=k2', '--adapter=./f.js'], {
      mod: { default: io },
    })
    expect(text).not.toContain('legacy-plaintext')
    expect(text).not.toContain('v1:')
    expect(text).not.toContain(K1)
  })
})
