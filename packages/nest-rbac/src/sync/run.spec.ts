/**
 * `taizan-rbac-sync` 命令：参数解析与 adapter 契约。
 *
 * 命令**不连库**，所以这里注入一个假的 `importModule`，验证的是「拿到 adapter 之后
 * 干了什么」以及「拿不到时报什么」。
 */

import { createFakePrisma, type FakePrismaControls } from '@taizan/nest-prisma/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { fixtureMenus, fixturePermissions } from '../testing/fixtures'
import { parseArgs, runSyncCli, type RbacSyncContext } from './run'

let controls: FakePrismaControls
let closed: number
let logs: string[]
let errors: string[]

function deps(module: unknown): Parameters<typeof runSyncCli>[1] {
  return {
    importModule: async (): Promise<unknown> => module,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
  }
}

function context(): RbacSyncContext {
  const fake = createFakePrisma()
  controls = fake.controls
  controls.on('Permission', 'findMany', [])
  controls.on('Menu', 'findMany', [])
  return {
    prisma: { raw: fake.client },
    permissions: [fixturePermissions()],
    menus: [fixtureMenus()],
    close: () => {
      closed += 1
    },
  }
}

beforeEach(() => {
  closed = 0
  logs = []
  errors = []
})

describe('parseArgs', () => {
  it('解析全部选项', () => {
    expect(parseArgs(['--adapter', './a.js', '--dry-run', '--max-delete-ratio', '1'])).toEqual({
      adapter: './a.js',
      dryRun: true,
      permissionsOnly: false,
      menusOnly: false,
      maxDeleteRatio: 1,
      help: false,
    })
  })

  it('未知参数抛错（而不是静默忽略——静默忽略等于「命令没按你说的做」）', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/未知参数/)
  })
})

describe('runSyncCli', () => {
  it('--help 打用法并返回 0', async () => {
    expect(await runSyncCli(['--help'], deps(null))).toBe(0)
    expect(logs.join('\n')).toContain('--adapter')
  })

  it('缺 --adapter 返回 2 并打用法', async () => {
    expect(await runSyncCli([], deps(null))).toBe(2)
    expect(errors.join('\n')).toContain('--adapter')
  })

  it('--permissions-only 与 --menus-only 互斥', async () => {
    const code = await runSyncCli(
      ['--adapter', './a.js', '--permissions-only', '--menus-only'],
      deps(null),
    )
    expect(code).toBe(2)
  })

  it('adapter 模块没有默认导出函数时报清楚的错', async () => {
    expect(await runSyncCli(['--adapter', './a.js'], deps({ nothing: true }))).toBe(1)
    expect(errors.join('\n')).toContain('createRbacSyncContext')
  })

  it('默认导出的 adapter 跑完两张表并返回 0', async () => {
    const code = await runSyncCli(['--adapter', './a.js'], deps({ default: context }))
    expect(code).toBe(0)
    expect(controls.callsOf('Permission', 'upsert')).toHaveLength(6)
    expect(controls.callsOf('Menu', 'upsert')).toHaveLength(8)
    expect(logs.join('\n')).toContain('Permission')
  })

  it('具名导出 createRbacSyncContext 也认', async () => {
    expect(
      await runSyncCli(['--adapter', './a.js'], deps({ createRbacSyncContext: context })),
    ).toBe(0)
  })

  it('--permissions-only 只同步一张表', async () => {
    await runSyncCli(['--adapter', './a.js', '--permissions-only'], deps({ default: context }))
    expect(controls.callsOf('Permission', 'upsert')).toHaveLength(6)
    expect(controls.callsOf('Menu', 'upsert')).toHaveLength(0)
  })

  it('--dry-run 一条写都不发', async () => {
    await runSyncCli(['--adapter', './a.js', '--dry-run'], deps({ default: context }))
    expect(controls.callsOf('Permission', 'upsert')).toHaveLength(0)
    expect(logs.join('\n')).toContain('dry-run')
  })

  it('无论成功失败都调 close（不然 CLI 会挂着不退出）', async () => {
    await runSyncCli(['--adapter', './a.js'], deps({ default: context }))
    expect(closed).toBe(1)
  })

  it('adapter 抛错时返回 1 并打错误', async () => {
    const boom = (): never => {
      throw new Error('连不上库')
    }
    expect(await runSyncCli(['--adapter', './a.js'], deps({ default: boom }))).toBe(1)
    expect(errors.join('\n')).toContain('连不上库')
  })
})
