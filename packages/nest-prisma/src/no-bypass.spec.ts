/**
 * 架构断言：**执行层不许自己实现隔离规则**。
 *
 * 单测能证明「现在的行为是对的」，证明不了「以后没人会在别处偷偷再写一遍」。
 * 隔离规则一旦出现第二份副本，两份就会各自演化，某天只改了一份——而租户串数据不会报错。
 * 所以这里直接扫源码，把「只有一份规则」这件事变成 CI 里会红的断言。
 *
 * 对应蓝图 §8 架构约束测试清单的思路；项目侧的 spec 3（`raw-usage.spec.ts`）扫的是
 * `RawPrismaService` 的注入点，两者互补。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))

/** 参与扫描的文件：本包全部生产代码。测试与测试替身不算。 */
function productionFiles(dir: string = SRC): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'testing') continue
      out.push(...productionFiles(full))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.spec.ts')) continue
    out.push(full)
  }
  return out
}

/**
 * 去掉注释再扫。
 *
 * 本包的 TSDoc 里到处在讨论 `tenantId` 和 `AND` 包裹——不剥注释的话，写得越清楚
 * 越容易假红，最后大家就把断言删了。
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const FILES = productionFiles()
const REL = (file: string): string => relative(SRC, file).replaceAll('\\', '/')
const CODE = new Map(FILES.map((file) => [REL(file), codeOf(file)]))

/** 唯一允许接触隔离决策的文件。 */
const DECISION_CONSUMER = 'extensions/tenant.ts'

describe('执行层没有绕开决策函数（源码扫描）', () => {
  it('扫描到了预期的文件，扫描器本身没有空跑', () => {
    // 哨兵：如果哪天目录结构变了导致一个文件都没扫到，下面所有断言都会「假绿」。
    expect(CODE.size).toBeGreaterThanOrEqual(8)
    expect(CODE.has(DECISION_CONSUMER)).toBe(true)
  })

  it('只有 extensions/tenant.ts 调隔离决策函数，别处一个都没有', () => {
    const callers = [...CODE.entries()]
      .filter(([, code]) => code.includes('planTenantScope') || code.includes('assertResultOwner'))
      .map(([file]) => file)

    expect(callers).toEqual([DECISION_CONSUMER])
  })

  it('没有任何生产代码把 tenantId 当条件写进 where', () => {
    const offenders: string[] = []
    for (const [file, code] of CODE) {
      code.split('\n').forEach((line, index) => {
        if (line.includes('tenantId') && line.includes('where')) {
          offenders.push(`${file}:${index + 1} ${line.trim()}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })

  it('生产代码里 tenantId 只能出现在两种形态：归属校验用的 select，以及类型标注', () => {
    // `tenantId: true` 是 verifyOwner 的 select；`tenantId: string` 是函数签名。
    // 除此之外任何 `tenantId: <值>` 都意味着执行层在自己拼归属条件。
    const allowed = new Set(['true', 'string'])
    const offenders: string[] = []

    for (const [file, code] of CODE) {
      for (const match of code.matchAll(/tenantId\s*:\s*([^,\n)}]+)/g)) {
        const value = (match[1] ?? '').trim()
        if (!allowed.has(value)) offenders.push(`${file}: tenantId: ${value}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('extensions/tenant.ts 里不出现 AND —— where 的 AND 包裹只能来自决策函数的 plan.args', () => {
    expect(CODE.get(DECISION_CONSUMER)).not.toMatch(/\bAND\b/)
  })

  it('extensions/tenant.ts 不对「没有租户上下文」做任何短路放行', () => {
    const code = CODE.get(DECISION_CONSUMER) ?? ''

    // 老项目的洞长这样：`if (!ctx?.tenantId || !MODELS.has(model)) return query(args)`
    expect(code).not.toMatch(/if\s*\(\s*!?\s*tenantId/)
    expect(code).not.toMatch(/if\s*\(\s*!\s*registered/)
    // 也不能自己判断「模型在不在名单里」——那是决策函数的第一步。
    expect(code).not.toMatch(/registered\.has\(/)
    // 更不能自己造 NO_CONTEXT 之外的说法，或者把它吞掉。
    expect(code).not.toContain('NO_CONTEXT')
  })

  it('ScopePlan 的四种 action 全部被显式处理，且有 never 兜底', () => {
    const code = CODE.get(DECISION_CONSUMER) ?? ''

    for (const action of ['passthrough', 'execute', 'checkResultOwner', 'verifyOwnerThenExecute']) {
      expect(code).toContain(`case '${action}'`)
    }
    // 决策层将来加了第五种 action，这里编译期就该红。
    expect(code).toMatch(/:\s*never\s*=\s*plan/)
  })

  it('软删 / ULID / 乐观锁三个扩展只用 tenant-scope 的命名转换，不碰隔离决策', () => {
    for (const file of [
      'extensions/soft-delete.ts',
      'extensions/ulid.ts',
      'extensions/optimistic-lock.ts',
    ]) {
      const code = CODE.get(file) ?? ''
      const imported = /from '@taizan\/tenant-scope'/.test(code)
      if (!imported) continue
      expect(code).toMatch(/import\s*\{\s*modelToClientKey\s*\}\s*from '@taizan\/tenant-scope'/)
    }
  })
})
