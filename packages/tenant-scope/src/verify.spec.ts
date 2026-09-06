import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseVerifySchemaArgs, runVerifySchemaCli } from './cli/verify-schema'
import { TenantScopeError } from './errors'
import {
  SENTINEL_SCHEMA,
  formatVerifySchemaReport,
  parsePrismaModels,
  runParserSentinel,
  verifySchema,
  type PrismaModelInfo,
} from './verify'

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const fixture = (name: string): string => join(FIXTURES, name)

describe('parsePrismaModels', () => {
  it('解析出 model 与 view，并区分 tenantId 的三种形态', () => {
    const parsed = parsePrismaModels(`
model A {
  id       String @id
  tenantId String
}

model B {
  id String @id
}

view C {
  id       String  @id
  tenantId String?
}
`)
    expect(parsed).toEqual([
      { name: 'A', kind: 'model', tenantId: 'required' },
      { name: 'B', kind: 'model', tenantId: 'none' },
      { name: 'C', kind: 'view', tenantId: 'nullable' },
    ])
  })

  it('注释掉的 tenantId 字段不算数', () => {
    const parsed = parsePrismaModels('model A {\n  id String @id\n  // tenantId String\n}\n')
    expect(parsed[0]?.tenantId).toBe('none')
  })

  it('块级属性里的 tenantId（@@index）不会被当成字段', () => {
    const parsed = parsePrismaModels('model A {\n  id String @id\n  @@index([tenantId, id])\n}\n')
    expect(parsed[0]?.tenantId).toBe('none')
  })

  it('CRLF 换行也能解析（Windows 上 checkout 出来就是这样）', () => {
    const parsed = parsePrismaModels('model A {\r\n  tenantId String\r\n}\r\n')
    expect(parsed).toEqual([{ name: 'A', kind: 'model', tenantId: 'required' }])
  })

  it('datasource / generator / enum 块不会被误认成 model', () => {
    const parsed = parsePrismaModels(`
datasource db {
  provider = "mysql"
}

enum Status {
  ON
  OFF
}

model A {
  tenantId String
}
`)
    expect(parsed.map((m) => m.name)).toEqual(['A'])
  })

  it('字符串里的 // 不会被当成注释切掉', () => {
    const parsed = parsePrismaModels(
      'model A {\n  url String @default("http://x")\n  tenantId String\n}\n',
    )
    expect(parsed[0]?.tenantId).toBe('required')
  })

  it('数组类型字段（关系列表）不影响判定', () => {
    const parsed = parsePrismaModels('model A {\n  kids Kid[]\n  tenantId String\n}\n')
    expect(parsed[0]?.tenantId).toBe('required')
  })
})

describe('正则失效防假通过哨兵', () => {
  it('真解析器能从内置 schema 文本里解出预期答案', () => {
    expect(runParserSentinel()).toBe(true)
  })

  it('内置哨兵文本本身包含带 tenantId 与不带 tenantId 两类块', () => {
    const parsed = parsePrismaModels(SENTINEL_SCHEMA)
    expect(parsed.length).toBeGreaterThan(2)
    expect(parsed.some((m) => m.tenantId === 'required')).toBe(true)
    expect(parsed.some((m) => m.tenantId === 'none')).toBe(true)
  })

  it('解析器什么都解不出来时（正则失效）哨兵报警', () => {
    expect(runParserSentinel(() => [])).toBe(false)
  })

  it('解析器只解出块名却读不到 tenantId 时也报警', () => {
    const blind = (source: string): PrismaModelInfo[] =>
      parsePrismaModels(source).map((m) => ({ ...m, tenantId: 'none' as const }))
    expect(runParserSentinel(blind)).toBe(false)
  })

  it('解析器把不带 tenantId 的表也算进来时同样报警（宁可误报不可漏报）', () => {
    const greedy = (source: string): PrismaModelInfo[] =>
      parsePrismaModels(source).map((m) => ({ ...m, tenantId: 'required' as const }))
    expect(runParserSentinel(greedy)).toBe(false)
  })

  it('解析器直接抛异常时哨兵返回 false 而不是把异常冒出去', () => {
    expect(
      runParserSentinel(() => {
        throw new Error('boom')
      }),
    ).toBe(false)
  })

  it('解析器返回的不是数组时也判失效', () => {
    expect(runParserSentinel(() => undefined as unknown as PrismaModelInfo[])).toBe(false)
  })

  it('哨兵失效时 verifySchema 的 ok 一定为 false，哪怕比对本身没问题', () => {
    const result = verifySchema({
      schemaDirs: [fixture('good.prisma')],
      registered: [],
      parser: () => [],
    })
    expect(result.sentinelOk).toBe(false)
    expect(result.ok).toBe(false)
    expect(formatVerifySchemaReport(result)).toContain('哨兵失效')
  })
})

describe('verifySchema 双向比对', () => {
  const goodRegistered = ['ScopedAlpha', 'ScopedBeta', 'ScopedGammaView']

  it('注册表与 schema 一致时全绿', () => {
    const result = verifySchema({
      schemaDirs: [fixture('good.prisma')],
      registered: goodRegistered,
    })
    expect(result.ok, formatVerifySchemaReport(result)).toBe(true)
    expect(result.missingInRegistry).toEqual([])
    expect(result.missingInSchema).toEqual([])
    expect(result.scannedFiles).toHaveLength(1)
  })

  it('平台域表（Tenant / Plan）不该被要求登记', () => {
    const result = verifySchema({
      schemaDirs: [fixture('good.prisma')],
      registered: goodRegistered,
    })
    expect(result.modelsWithTenantId).not.toContain('Tenant')
    expect(result.modelsWithTenantId).not.toContain('Plan')
  })

  it('带 tenantId 却漏登记 → missingInRegistry，且报告写明「毫无租户隔离」', () => {
    const result = verifySchema({
      schemaDirs: [fixture('bad-missing-registry.prisma')],
      registered: ['ScopedAlpha'],
    })
    expect(result.ok).toBe(false)
    expect(result.missingInRegistry).toEqual(['ScopedOrphan'])
    expect(formatVerifySchemaReport(result)).toContain('毫无租户隔离')
  })

  it('登记了 schema 里没有的表 → missingInSchema', () => {
    const result = verifySchema({
      schemaDirs: [fixture('bad-missing-schema.prisma')],
      registered: ['ScopedAlpha', 'PlatformOnly', 'GhostTable'],
    })
    expect(result.ok).toBe(false)
    expect(result.missingInSchema).toEqual(['GhostTable', 'PlatformOnly'])
  })

  it('ReadonlySet 与数组两种 registered 都接受', () => {
    const fromSet = verifySchema({
      schemaDirs: [fixture('good.prisma')],
      registered: new Set(goodRegistered),
    })
    expect(fromSet.ok).toBe(true)
  })

  it('可空 tenantId 会被拦下（蓝图 §3.1：可空归属等于隔离有例外）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taizan-scope-'))
    writeFileSync(join(dir, 'a.prisma'), 'model Loose {\n  tenantId String?\n}\n')
    const result = verifySchema({ schemaDirs: [dir], registered: ['Loose'] })
    expect(result.nullableTenantId).toEqual(['Loose'])
    expect(result.ok).toBe(false)
    expect(formatVerifySchemaReport(result)).toContain('可空')
  })

  it('目录会被递归扫描，多文件 schema 一并比对', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taizan-scope-'))
    writeFileSync(join(dir, '01-a.prisma'), 'model A {\n  tenantId String\n}\n')
    writeFileSync(join(dir, '02-b.prisma'), 'model B {\n  tenantId String\n}\n')
    writeFileSync(join(dir, 'notes.md'), '不是 prisma 文件，不该被扫')
    const result = verifySchema({ schemaDirs: [dir], registered: ['A', 'B'] })
    expect(result.scannedFiles).toHaveLength(2)
    expect(result.ok).toBe(true)
  })

  it('一个 .prisma 都没扫到时不算通过（路径指错导致的假通过）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taizan-scope-'))
    const result = verifySchema({ schemaDirs: [dir], registered: [] })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toHaveLength(1)
    expect(formatVerifySchemaReport(result)).toContain('读不到')
  })

  it('路径根本不存在时记进 unreadable 而不是抛异常', () => {
    const result = verifySchema({
      schemaDirs: [join(tmpdir(), 'taizan-does-not-exist-42')],
      registered: [],
    })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toHaveLength(1)
  })

  it('一个 schema 路径都不给时抛 INVALID_ARGUMENT', () => {
    expect(() => verifySchema({ schemaDirs: [], registered: [] })).toThrow(TenantScopeError)
  })
})

describe('verifySchema 的 allowlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taizan-scope-allow-'))
  writeFileSync(
    join(dir, 'a.prisma'),
    'model Kept {\n  tenantId String\n}\n\nmodel Excused {\n  tenantId String\n}\n',
  )

  it('写了理由的白名单条目会被放过', () => {
    const result = verifySchema({
      schemaDirs: [dir],
      registered: ['Kept'],
      allowlist: [{ model: 'Excused', reason: '平台域统计表，跨租户聚合，读写只在平台后台' }],
    })
    expect(result.ok, formatVerifySchemaReport(result)).toBe(true)
    expect(result.missingInRegistry).toEqual([])
  })

  it('reason 为空串的条目无效，校验照样红', () => {
    const result = verifySchema({
      schemaDirs: [dir],
      registered: ['Kept'],
      allowlist: [{ model: 'Excused', reason: '' }],
    })
    expect(result.ok).toBe(false)
    expect(result.invalidAllowlist[0]?.problem).toContain('reason 不能为空')
    expect(result.missingInRegistry).toEqual(['Excused'])
  })

  it('reason 只有空白同样无效', () => {
    const result = verifySchema({
      schemaDirs: [dir],
      registered: ['Kept'],
      allowlist: [{ model: 'Excused', reason: '   ' }],
    })
    expect(result.ok).toBe(false)
  })

  it('model 为空的条目无效', () => {
    const result = verifySchema({
      schemaDirs: [dir],
      registered: ['Kept', 'Excused'],
      allowlist: [{ model: '', reason: '忘了写表名' }],
    })
    expect(result.invalidAllowlist[0]?.model).toBe('(空)')
  })

  it('重复的白名单条目会被指出来', () => {
    const result = verifySchema({
      schemaDirs: [dir],
      registered: ['Kept'],
      allowlist: [
        { model: 'Excused', reason: '理由一' },
        { model: 'Excused', reason: '理由二' },
      ],
    })
    expect(result.invalidAllowlist[0]?.problem).toContain('重复')
  })

  it('白名单里写了 schema 中不存在的表 → 条目已过期', () => {
    const result = verifySchema({
      schemaDirs: [dir],
      registered: ['Kept', 'Excused'],
      allowlist: [{ model: 'Vanished', reason: '早就删了' }],
    })
    expect(result.invalidAllowlist[0]?.problem).toContain('已过期')
  })

  it('同时出现在注册表和白名单里必须二选一', () => {
    const result = verifySchema({
      schemaDirs: [dir],
      registered: ['Kept', 'Excused'],
      allowlist: [{ model: 'Excused', reason: '既登记又豁免，自相矛盾' }],
    })
    expect(result.invalidAllowlist[0]?.problem).toContain('二选一')
  })
})

describe('formatVerifySchemaReport', () => {
  it('通过时给出明确的成功行', () => {
    const result = verifySchema({
      schemaDirs: [fixture('good.prisma')],
      registered: ['ScopedAlpha', 'ScopedBeta', 'ScopedGammaView'],
    })
    expect(formatVerifySchemaReport(result)).toContain('双向一致')
  })

  it('失败时把每一类问题都列出来', () => {
    const report = formatVerifySchemaReport(
      verifySchema({ schemaDirs: [fixture('bad-missing-registry.prisma')], registered: ['Ghost'] }),
    )
    expect(report).toContain('ScopedAlpha')
    expect(report).toContain('ScopedOrphan')
    expect(report).toContain('Ghost')
  })

  it('无效的 allowlist 条目也会出现在报告里', () => {
    const report = formatVerifySchemaReport(
      verifySchema({
        schemaDirs: [fixture('good.prisma')],
        registered: ['ScopedAlpha', 'ScopedBeta', 'ScopedGammaView'],
        allowlist: [{ model: 'ScopedAlpha', reason: '' }],
      }),
    )
    expect(report).toContain('allowlist 条目无效')
    expect(report).toContain('ScopedAlpha')
  })
})

describe('verify-schema CLI', () => {
  const run = (argv: string[]): { code: number; out: string } => {
    const lines: string[] = []
    const code = runVerifySchemaCli(argv, (line) => lines.push(line))
    return { code, out: lines.join('\n') }
  }

  it('参数解析：位置参数、--registered 可重复、--allow 可重复', () => {
    const parsed = parseVerifySchemaArgs([
      'a',
      'b',
      '--registered=X,Y',
      '--registered= Z ',
      '--allow=W:因为它是平台表',
    ])
    expect(parsed.schemaDirs).toEqual(['a', 'b'])
    expect(parsed.registered).toEqual(['X', 'Y', 'Z'])
    expect(parsed.allowlist).toEqual([{ model: 'W', reason: '因为它是平台表' }])
    expect(parsed.errors).toEqual([])
  })

  it('good fixture + 正确的 --registered → 退出码 0', () => {
    const { code, out } = run([
      fixture('good.prisma'),
      '--registered=ScopedAlpha,ScopedBeta,ScopedGammaView',
    ])
    expect(code).toBe(0)
    expect(out).toContain('双向一致')
  })

  it('bad-missing-registry + --registered=Tenant → 非零退出并打印中文清单', () => {
    const { code, out } = run([fixture('bad-missing-registry.prisma'), '--registered=Tenant'])
    expect(code).toBe(1)
    expect(out).toContain('毫无租户隔离')
    expect(out).toContain('ScopedOrphan')
  })

  it('bad-missing-schema + 多登记一张表 → 非零退出', () => {
    const { code, out } = run([
      fixture('bad-missing-schema.prisma'),
      '--registered=ScopedAlpha,PlatformOnly',
    ])
    expect(code).toBe(1)
    expect(out).toContain('查无 tenantId 列')
  })

  it('--allow 写了理由能救回 good fixture 里未登记的表', () => {
    const { code } = run([
      fixture('good.prisma'),
      '--registered=ScopedAlpha,ScopedBeta',
      '--allow=ScopedGammaView:只读聚合视图，由平台后台跨租户使用',
    ])
    expect(code).toBe(0)
  })

  it('--allow 不写理由 → 退出码 2（参数就不合法）', () => {
    const { code, out } = run([fixture('good.prisma'), '--allow=ScopedGammaView'])
    expect(code).toBe(2)
    expect(out).toContain('白名单不写理由等于没有白名单')
  })

  it('未知选项 → 退出码 2', () => {
    const { code, out } = run([fixture('good.prisma'), '--nope'])
    expect(code).toBe(2)
    expect(out).toContain('未知选项')
  })

  it('不给路径 → 退出码 2 并打印用法', () => {
    const { code, out } = run(['--registered=A'])
    expect(code).toBe(2)
    expect(out).toContain('用法：')
  })

  it('--help 打印用法并退出码 0', () => {
    const { code, out } = run(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('--registered')
  })

  it('--allow 只写了冒号后半段（缺表名）→ 退出码 2', () => {
    const { code, out } = run([fixture('good.prisma'), '--allow=:没有表名'])
    expect(code).toBe(2)
    expect(out).toContain('Model:理由')
  })

  it('默认 write 走 console.log（不传回调也能跑）', () => {
    const original = console.log
    const lines: string[] = []
    console.log = (line: string): void => {
      lines.push(line)
    }
    try {
      expect(runVerifySchemaCli(['--help'])).toBe(0)
    } finally {
      console.log = original
    }
    expect(lines.join('\n')).toContain('用法：')
  })
})
