/**
 * 解析器与约定检查器自身的单测。
 *
 * 真 schema 那份 spec 只能证明「当前 schema 没违规」，证明不了「检查器抓得住违规」——
 * 一个永远返回空数组的检查器也能让它全绿。所以这里逐条喂违规样本，确认每条规则真的会红。
 */

import { describe, expect, it } from 'vitest'

import {
  LINT_SENTINEL_SCHEMA,
  formatSchemaLintReport,
  lintSchemaConventions,
  parsePrismaSchema,
  runSchemaLintSentinel,
} from './schema-lint'

const OK_MODEL = `
model Good {
  id        String   @id @db.VarChar(26)
  tenantId  String   @db.VarChar(26)
  status    GoodStatus
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId, id])
}

enum GoodStatus {
  A
  B
}
`

function rulesOf(source: string, allowRelations = true): string[] {
  return lintSchemaConventions(parsePrismaSchema(source, 'x.prisma'), { allowRelations })
    .map((f) => f.rule)
    .sort()
}

describe('parsePrismaSchema', () => {
  it('解析 model 的字段、块级属性与 enum', () => {
    const ast = parsePrismaSchema(OK_MODEL, 'x.prisma')
    expect(ast.models).toHaveLength(1)
    expect(ast.enums).toHaveLength(1)
    expect(ast.models[0]?.fields.map((f) => f.name)).toEqual([
      'id',
      'tenantId',
      'status',
      'createdAt',
      'updatedAt',
    ])
    expect(ast.models[0]?.blockAttributes).toEqual(['@@index([tenantId, id])'])
    expect(ast.enums[0]?.values).toEqual(['A', 'B'])
    expect(ast.models[0]?.file).toBe('x.prisma')
  })

  it('注释掉的字段不算数，`///` 文档注释不当成字段', () => {
    const ast = parsePrismaSchema(
      `model M {
  /// 文档注释
  id String @id
  // tenantId String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`,
    )
    expect(ast.models[0]?.fields.map((f) => f.name)).toEqual(['id', 'createdAt', 'updatedAt'])
  })

  it('行尾注释被剥掉，但引号里的 // 不受影响', () => {
    const ast = parsePrismaSchema(
      `model M {
  id  String @id // 主键
  url String @default("http://example.com")
}`,
    )
    expect(ast.models[0]?.fields[1]?.attributes).toBe('@default("http://example.com")')
  })

  it('识别 view 块与可空、列表字段', () => {
    const ast = parsePrismaSchema(
      `view V {
  id    String   @id
  tags  String[]
  memo  String?
}`,
    )
    expect(ast.models[0]?.kind).toBe('view')
    expect(ast.models[0]?.fields[1]?.list).toBe(true)
    expect(ast.models[0]?.fields[2]?.optional).toBe(true)
  })

  it('CRLF 换行照样解析', () => {
    const ast = parsePrismaSchema(OK_MODEL.replace(/\n/g, '\r\n'))
    expect(ast.models[0]?.fields).toHaveLength(5)
  })

  it('空文本解析出空结果', () => {
    expect(parsePrismaSchema('')).toEqual({ models: [], enums: [] })
  })
})

describe('runSchemaLintSentinel', () => {
  it('默认解析器通过哨兵', () => {
    expect(runSchemaLintSentinel()).toBe(true)
  })

  it('解析器抛异常时哨兵判红', () => {
    expect(
      runSchemaLintSentinel(() => {
        throw new Error('boom')
      }),
    ).toBe(false)
  })

  it('解析器悄悄少解析一个字段时哨兵判红（这才是最危险的失效形态）', () => {
    expect(
      runSchemaLintSentinel((source, file) => {
        const ast = parsePrismaSchema(source, file)
        ast.models[0]?.fields.pop()
        return ast
      }),
    ).toBe(false)
  })

  it('哨兵文本本身是合法的、能被解析出预期形状的 schema', () => {
    const ast = parsePrismaSchema(LINT_SENTINEL_SCHEMA)
    expect(ast.models).toHaveLength(1)
    expect(ast.enums).toHaveLength(1)
  })
})

describe('lintSchemaConventions 抓得住违规', () => {
  it('干净样本零违规', () => {
    const findings = lintSchemaConventions(parsePrismaSchema(OK_MODEL))
    expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
    expect(formatSchemaLintReport(findings)).toContain('✓')
  })

  it('Decimal 被抓', () => {
    expect(
      rulesOf(`model M {
  id String @id
  amountCents Decimal
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`),
    ).toContain('no-decimal')
  })

  it('金额列不以 Cents 结尾被抓', () => {
    expect(
      rulesOf(`model M {
  id String @id
  priceCentsFirst Int
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`),
    ).toContain('money-cents')
  })

  it('金额列是 Float 被抓', () => {
    expect(
      rulesOf(`model M {
  id String @id
  feeCents Float
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`),
    ).toContain('money-cents')
  })

  it('Int 主键被抓', () => {
    expect(
      rulesOf(`model M {
  id Int @id
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`),
    ).toContain('id-string')
  })

  it('没有主键被抓', () => {
    expect(
      rulesOf(`model M {
  name String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`),
    ).toContain('id-string')
  })

  it('裸 String 的 status 被抓，登记豁免后放行', () => {
    const source = `model M {
  id String @id
  status String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`
    expect(rulesOf(source)).toContain('enum-status')
    const findings = lintSchemaConventions(parsePrismaSchema(source), {
      enumExemptions: [{ model: 'M', field: 'status', reason: '临时' }],
    })
    expect(findings.map((f) => f.rule)).not.toContain('enum-status')
  })

  it('以 Type/Kind 结尾的裸列也被抓', () => {
    expect(
      rulesOf(`model M {
  id String @id
  actorType String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`),
    ).toContain('enum-status')
  })

  it('租户表缺 @@index([tenantId, id]) 被抓', () => {
    expect(
      rulesOf(`model M {
  id String @id
  tenantId String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`),
    ).toContain('tenant-index')
  })

  it('软删表的 @@unique 不带 deletedAt 被抓', () => {
    expect(
      rulesOf(`model M {
  id String @id
  code String
  deletedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([code])
}`),
    ).toContain('soft-delete-unique')
  })

  it('软删表上的字段级 @unique 被抓', () => {
    expect(
      rulesOf(`model M {
  id String @id
  code String @unique
  deletedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`),
    ).toContain('soft-delete-unique')
  })

  it('缺 createdAt / updatedAt 被抓', () => {
    expect(rulesOf('model M {\n  id String @id\n}')).toEqual(['timestamps', 'timestamps'])
  })

  it('updatedAt 少了 @updatedAt、createdAt 少了 @default(now()) 被抓', () => {
    expect(
      rulesOf(`model M {
  id String @id
  createdAt DateTime
  updatedAt DateTime
}`),
    ).toEqual(['timestamps', 'timestamps'])
  })

  it('@map / @@map 被抓', () => {
    expect(
      rulesOf(`model M {
  id String @id @map("m_id")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("m")
}`).filter((r) => r === 'no-map'),
    ).toHaveLength(2)
  })

  it('allowRelations=false 时 relation 字段被抓，默认放行', () => {
    const source = `model A {
  id String @id
  b  B
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model B {
  id String @id
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}`
    expect(rulesOf(source, false)).toContain('no-relation')
    expect(rulesOf(source, true)).not.toContain('no-relation')
  })

  it('报告里带规则名、文件名与模型名', () => {
    const findings = lintSchemaConventions(
      parsePrismaSchema('model M {\n  id Int @id\n}', 'y.prisma'),
    )
    const report = formatSchemaLintReport(findings)
    expect(report).toContain('id-string')
    expect(report).toContain('y.prisma')
    expect(report).toContain('M')
  })
})
