/**
 * `taizan-verify-schema` 包装层的单测。
 *
 * 校验逻辑本体在 `@taizan/tenant-scope`（那边已有自己的用例），这里只证明包装层
 * 确实把框架基础表补进去了——补漏了的话，业务项目跑校验会说「框架的 10 张表都没登记」，
 * 或者更糟：业务自己手抄一份表名，抄漏一张就是一张没有隔离的表。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BASE_PLATFORM_ALLOWLIST, BASE_TENANT_MODELS } from '../tenant-models'
import { runBaseVerifySchemaCli, withBaseArgs } from './verify'

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SCHEMA_DIR = join(PACKAGE_ROOT, 'schema')

function collect(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = []
  return { lines, write: (line) => void lines.push(line) }
}

describe('withBaseArgs', () => {
  it('把全部框架租户表拼进 --registered', () => {
    const argv = withBaseArgs(['prisma/schema'])
    expect(argv[0]).toBe(`--registered=${BASE_TENANT_MODELS.join(',')}`)
    for (const model of BASE_TENANT_MODELS) expect(argv[0]).toContain(model)
    expect(argv.at(-1)).toBe('prisma/schema')
  })

  it('白名单条目按 Model:理由 拼成 --allow（当前为空）', () => {
    const argv = withBaseArgs([])
    expect(argv.filter((a) => a.startsWith('--allow='))).toHaveLength(
      BASE_PLATFORM_ALLOWLIST.length,
    )
  })

  it('用户自己的参数原样保留在后面', () => {
    expect(withBaseArgs(['a', '--registered=Goods'])).toEqual([
      `--registered=${BASE_TENANT_MODELS.join(',')}`,
      'a',
      '--registered=Goods',
    ])
  })
})

describe('runBaseVerifySchemaCli', () => {
  it('对框架自己的 schema 校验通过（退出 0）', () => {
    const { lines, write } = collect()
    expect(runBaseVerifySchemaCli([SCHEMA_DIR], write)).toBe(0)
    expect(lines.join('\n')).toContain('双向一致')
  })

  it('业务项目多报一张 schema 里没有的表 → 退出 1 并指名道姓', () => {
    const { lines, write } = collect()
    expect(runBaseVerifySchemaCli([SCHEMA_DIR, '--registered=Ghost'], write)).toBe(1)
    expect(lines.join('\n')).toContain('Ghost')
  })

  it('--help 不塞框架表名，直接透传', () => {
    const { lines, write } = collect()
    expect(runBaseVerifySchemaCli(['--help'], write)).toBe(0)
    const help = lines.join('\n')
    expect(help).toContain('--registered')
    expect(help).not.toContain('TenantCredential')
  })

  it('一个路径都不给 → 退出 2', () => {
    const { write } = collect()
    expect(runBaseVerifySchemaCli([], write)).toBe(2)
  })
})
