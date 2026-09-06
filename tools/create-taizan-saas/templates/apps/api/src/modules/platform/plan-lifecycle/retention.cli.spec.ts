import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  computeRetentionDueAt,
  formatReport,
  isRetentionOverdue,
  listOverdueTenants,
  type OverdueTenant,
} from './retention.cli'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'retention.cli.ts'), 'utf8')

describe('retention.cli.ts 源码：只标记不删（蓝图 §4.6 那条红线）', () => {
  it('哨兵：扫描器本身认得出违规写法（不然下面的"零违规"是因为没扫到任何东西）', () => {
    const bad = 'await prisma.tenant.delete({ where: { id } })\nDROP TABLE "Tenant";'
    expect(/delete/i.test(bad)).toBe(true)
    expect(/\bdrop\b/i.test(bad)).toBe(true)
  })

  it('源码里一个 delete 字样都不出现（不区分大小写，包括注释）', () => {
    expect(/delete/i.test(SOURCE)).toBe(false)
  })

  it('源码里一个 DROP 字样都不出现（不区分大小写，包括注释）', () => {
    expect(/\bdrop\b/i.test(SOURCE)).toBe(false)
  })

  it('确实扫到了真文件内容，不是空字符串（否则上面两条会永远假通过）', () => {
    expect(SOURCE.length).toBeGreaterThan(500)
    expect(SOURCE).toContain('listOverdueTenants')
  })
})

describe('computeRetentionDueAt / isRetentionOverdue', () => {
  it('到期时刻 = deregisterAt + retentionDays 天', () => {
    const deregisterAt = new Date('2026-01-01T00:00:00.000Z')
    expect(computeRetentionDueAt(deregisterAt, 7).toISOString()).toBe('2026-01-08T00:00:00.000Z')
  })

  it('恰好到点算已超期（含边界）', () => {
    const deregisterAt = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = computeRetentionDueAt(deregisterAt, 7)
    expect(isRetentionOverdue(deregisterAt, 7, dueAt)).toBe(true)
  })

  it('差一毫秒还没到不算超期', () => {
    const deregisterAt = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = computeRetentionDueAt(deregisterAt, 7)
    expect(isRetentionOverdue(deregisterAt, 7, new Date(dueAt.getTime() - 1))).toBe(false)
  })

  it('retentionDays=0 意味着注销当天就算到期', () => {
    const deregisterAt = new Date('2026-01-01T00:00:00.000Z')
    expect(isRetentionOverdue(deregisterAt, 0, deregisterAt)).toBe(true)
  })
})

describe('listOverdueTenants（只读，不做任何写操作）', () => {
  const NOW = new Date('2026-03-01T00:00:00.000Z')

  function fakePrisma(
    rows: {
      id: string
      slug: string
      name: string
      deregisterAt: Date | null
      retentionDays: number
    }[],
  ) {
    return { tenant: { findMany: async () => rows } }
  }

  it('只返回超过保留期的 DEREGISTERED 租户', async () => {
    const overdue = await listOverdueTenants(
      fakePrisma([
        {
          id: 't-old',
          slug: 'old-shop',
          name: '早就该清的店',
          deregisterAt: new Date('2026-01-01T00:00:00.000Z'),
          retentionDays: 7,
        },
        {
          id: 't-fresh',
          slug: 'fresh-shop',
          name: '刚注销还在保留期内',
          deregisterAt: new Date('2026-02-28T00:00:00.000Z'),
          retentionDays: 30,
        },
      ]),
      NOW,
    )
    expect(overdue.map((r) => r.id)).toEqual(['t-old'])
    expect(overdue[0]?.dueAt.toISOString()).toBe('2026-01-08T00:00:00.000Z')
  })

  it('deregisterAt 为 null 的行被跳过（理论上不该出现，防御性处理）', async () => {
    const overdue = await listOverdueTenants(
      fakePrisma([{ id: 't-null', slug: 's', name: 'n', deregisterAt: null, retentionDays: 7 }]),
      NOW,
    )
    expect(overdue).toEqual([])
  })

  it('没有任何超期租户时返回空数组', async () => {
    expect(await listOverdueTenants(fakePrisma([]), NOW)).toEqual([])
  })
})

describe('formatReport', () => {
  const row: OverdueTenant = {
    id: 't1',
    slug: 'shop-1',
    name: '示例店',
    deregisterAt: new Date('2026-01-01T00:00:00.000Z'),
    retentionDays: 7,
    dueAt: new Date('2026-01-08T00:00:00.000Z'),
  }

  it('空名单给出清晰的"没有"文案', () => {
    expect(formatReport([], true)).toContain('没有已超过保留期')
  })

  it('--dry-run 的报告文案里点名"只列名单，不做任何改动"', () => {
    expect(formatReport([row], true)).toContain('只列名单，不做任何改动')
    expect(formatReport([row], true)).toContain('shop-1')
  })

  it('非 --dry-run 也不承诺会清理（真正的清理留 TODO）', () => {
    const report = formatReport([row], false)
    expect(report).toContain('shop-1')
    expect(/delete/i.test(report)).toBe(false)
  })
})
