/**
 * 框架基础 schema 的静态断言。
 *
 * 这份 spec 是「表结构一旦发出去就难改」这句话的唯一执行者：蓝图 §3.1 的数据约定、
 * spec 9（金额）、spec 10（主键/枚举/索引）、spec 11 的一半（加密列对账）、
 * 以及租户模型注册表与 schema 的双向比对，全在这里逐条断言。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatVerifySchemaReport, verifySchema } from '@taizan/tenant-scope'
import { describe, expect, it } from 'vitest'

import { ENCRYPTED_COLUMNS, ENCRYPTED_COLUMN_SUFFIX } from './encrypted-columns'
import {
  formatSchemaLintReport,
  lintSchemaConventions,
  parsePrismaSchema,
  runSchemaLintSentinel,
  type PrismaEnum,
  type PrismaModel,
  type PrismaSchemaAst,
} from './schema-lint'
import { BASE_SCHEMA_FILES, MANAGED_FILE_BANNER } from './schema-files'
import { BASE_PLATFORM_ALLOWLIST, BASE_TENANT_MODELS } from './tenant-models'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCHEMA_DIR = join(PACKAGE_ROOT, 'schema')

/** `AuditLog.targetType` 这类「值域是业务实体名」的自由文本列，做成 enum 反而错。 */
const ENUM_EXEMPTIONS = [
  {
    model: 'AuditLog',
    field: 'targetType',
    reason: '存的是业务实体名（Goods / Member …），做成 enum 等于每加一张业务表都要改框架 schema。',
  },
  {
    model: 'PlatformAuditLog',
    field: 'targetType',
    reason: '同 AuditLog.targetType。',
  },
]

function readAllSchemas(): { ast: PrismaSchemaAst; sources: Map<string, string> } {
  const sources = new Map<string, string>()
  const ast: PrismaSchemaAst = { models: [], enums: [] }
  for (const name of BASE_SCHEMA_FILES) {
    const source = readFileSync(join(SCHEMA_DIR, name), 'utf8')
    sources.set(name, source)
    const parsed = parsePrismaSchema(source, name)
    ast.models.push(...parsed.models)
    ast.enums.push(...parsed.enums)
  }
  return { ast, sources }
}

const { ast, sources } = readAllSchemas()

/** 带 `tenantId` 的模型 = 租户域模型。 */
const tenantModels = ast.models.filter((m) => m.fields.some((f) => f.name === 'tenantId'))

describe('schema 目录本身', () => {
  it('解析器哨兵通过（防「正则失效导致全绿」的假通过）', () => {
    expect(runSchemaLintSentinel()).toBe(true)
  })

  it('目录里的 .prisma 文件与 BASE_SCHEMA_FILES 完全一致', () => {
    const actual = readdirSync(SCHEMA_DIR)
      .filter((n) => n.endsWith('.prisma'))
      .sort()
    expect(actual).toEqual([...BASE_SCHEMA_FILES].sort())
  })

  it('每个片段的文件头都带「框架托管，勿手改」横幅', () => {
    for (const [name, source] of sources) {
      expect(source.slice(0, 400), `${name} 缺少托管横幅`).toContain(MANAGED_FILE_BANNER)
    }
  })

  it('generator 与 datasource 有且只有一处，且都在 00-datasource.prisma', () => {
    let generators = 0
    let datasources = 0
    for (const [name, source] of sources) {
      const g = source.match(/^generator\s+/gm)?.length ?? 0
      const d = source.match(/^datasource\s+/gm)?.length ?? 0
      if (name !== '00-datasource.prisma') {
        expect(g + d, `${name} 里不该有 generator/datasource`).toBe(0)
      }
      generators += g
      datasources += d
    }
    expect(generators).toBe(1)
    expect(datasources).toBe(1)
  })

  it('datasource 用 mysql + env("DATABASE_URL")', () => {
    const source = sources.get('00-datasource.prisma') ?? ''
    expect(source).toMatch(/provider\s*=\s*"mysql"/)
    expect(source).toMatch(/url\s*=\s*env\("DATABASE_URL"\)/)
  })

  it('prisma validate 通过', () => {
    const result = spawnSync('pnpm', ['exec', 'prisma', 'validate', '--schema', 'schema'], {
      cwd: PACKAGE_ROOT,
      shell: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        // 不依赖包里的 .env：CI 上没有它，spec 也必须绿。
        DATABASE_URL: 'mysql://taizan:taizan@127.0.0.1:3306/taizan_schema_validate_only',
      },
    })
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('valid')
    expect(result.status, `${result.stdout ?? ''}\n${result.stderr ?? ''}`).toBe(0)
  })

  it('解析出的表与 enum 数量与文档一致（改了数量就要同步 README）', () => {
    expect(ast.models).toHaveLength(27)
    expect(ast.enums).toHaveLength(24)
  })
})

describe('蓝图 spec 9：金额口径', () => {
  it('全 schema 没有 Decimal', () => {
    for (const model of ast.models) {
      for (const field of model.fields) {
        expect(field.type, `${model.name}.${field.name}`).not.toBe('Decimal')
      }
    }
  })

  it('名含 price/amount/fee/balance 的数值列都是 Int 且以 Cents 结尾', () => {
    const findings = lintSchemaConventions(ast, {
      enumExemptions: ENUM_EXEMPTIONS,
      allowRelations: false,
    }).filter((f) => f.rule === 'money-cents' || f.rule === 'no-decimal')
    expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
  })

  it('确实存在被这条规则覆盖到的列（防「规则没匹配到任何列也算过」）', () => {
    const money = ast.models.flatMap((m) =>
      m.fields.filter((f) => /price|amount|fee|balance/i.test(f.name)).map((f) => f.name),
    )
    // firstPriceCents / renewPriceCents / amountCents 三列命中关键词；
    // discountCents 不含关键词但同样以 Cents 结尾，靠 §3.1 的命名约定兜住。
    expect(money.sort()).toEqual(['amountCents', 'firstPriceCents', 'renewPriceCents'])
    for (const name of money) expect(name.endsWith('Cents')).toBe(true)
  })
})

describe('蓝图 spec 10：主键 / 枚举 / 索引', () => {
  it('所有 @id 都是 String，且每张表恰好一个', () => {
    const findings = lintSchemaConventions(ast, {
      enumExemptions: ENUM_EXEMPTIONS,
    }).filter((f) => f.rule === 'id-string')
    expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
  })

  it('主键与 tenantId 都声明成 @db.VarChar(26)（ULID 定长，省一半索引体积）', () => {
    for (const model of ast.models) {
      for (const field of model.fields) {
        if (field.name === 'id' || field.name === 'tenantId') {
          expect(field.attributes, `${model.name}.${field.name}`).toContain('@db.VarChar(26)')
        }
      }
    }
  })

  it('status / type / kind 类列一律 enum', () => {
    const findings = lintSchemaConventions(ast, {
      enumExemptions: ENUM_EXEMPTIONS,
    }).filter((f) => f.rule === 'enum-status')
    expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
  })

  it('enum 豁免清单里的每一项都真实存在且写了理由', () => {
    for (const entry of ENUM_EXEMPTIONS) {
      expect(entry.reason.trim().length).toBeGreaterThan(0)
      const model = ast.models.find((m) => m.name === entry.model)
      expect(model, `豁免清单里的 ${entry.model} 在 schema 里不存在`).toBeDefined()
      expect((model as PrismaModel).fields.some((f) => f.name === entry.field)).toBe(true)
    }
  })

  it('每张租户表都有 @@index([tenantId, id])', () => {
    expect(tenantModels.length).toBeGreaterThan(0)
    for (const model of tenantModels) {
      const normalized = model.blockAttributes.map((a) => a.replace(/\s+/g, ''))
      expect(normalized, `${model.name} 缺 @@index([tenantId, id])`).toContain(
        '@@index([tenantId,id])',
      )
    }
  })

  it('租户列一律 NOT NULL（可空归属 = 隔离有例外，§3.1 明令禁止）', () => {
    for (const model of ast.models) {
      const tenantId = model.fields.find((f) => f.name === 'tenantId')
      if (tenantId === undefined) continue
      expect(tenantId.optional, `${model.name}.tenantId 不许可空`).toBe(false)
      expect(tenantId.type).toBe('String')
    }
  })

  it('有 deletedAt 的表，唯一索引都带 deletedAt，且没有字段级 @unique', () => {
    const softDeleted = ast.models.filter((m) => m.fields.some((f) => f.name === 'deletedAt'))
    expect(softDeleted.length).toBeGreaterThan(0)
    const findings = lintSchemaConventions(ast, {
      enumExemptions: ENUM_EXEMPTIONS,
    }).filter((f) => f.rule === 'soft-delete-unique')
    expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
  })

  it('deletedAt 一律是可空 DateTime', () => {
    for (const model of ast.models) {
      const deletedAt = model.fields.find((f) => f.name === 'deletedAt')
      if (deletedAt === undefined) continue
      expect(deletedAt.type).toBe('DateTime')
      expect(deletedAt.optional, `${model.name}.deletedAt 必须可空`).toBe(true)
    }
  })

  it('TenantStatus 枚举不得含 EXPIRED（蓝图 §3.2/§4.5：到期永远现算，不落状态位）', () => {
    // 哨兵：先确认解析器真的能读到这个 enum，否则下面的 not.toContain 是「没找到等于通过」的假绿。
    const tenantStatus = ast.enums.find((e) => e.name === 'TenantStatus')
    expect(tenantStatus, 'TenantStatus enum 在 schema 里不存在——解析器可能失效了').toBeDefined()
    expect((tenantStatus as PrismaEnum).values.length).toBeGreaterThan(0)
    expect(
      (tenantStatus as PrismaEnum).values,
      '到期状态一律由 evaluateTenantGate 现算，不允许把 EXPIRED 落成状态位——' +
        '一旦落地，闸门逻辑与状态位就有两处真源，迟早对不齐。',
    ).not.toContain('EXPIRED')
  })
})

describe('蓝图 §3.1 的其余约定', () => {
  it('createdAt / updatedAt 每张表都有，且带 @default(now()) / @updatedAt', () => {
    const findings = lintSchemaConventions(ast, {
      enumExemptions: ENUM_EXEMPTIONS,
    }).filter((f) => f.rule === 'timestamps')
    expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
  })

  it('camelCase 直用：没有 @map / @@map', () => {
    const findings = lintSchemaConventions(ast, {
      enumExemptions: ENUM_EXEMPTIONS,
    }).filter((f) => f.rule === 'no-map')
    expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
  })

  it('一条 relation 都不建（含不建指向 Tenant 的外键）', () => {
    const findings = lintSchemaConventions(ast, {
      enumExemptions: ENUM_EXEMPTIONS,
      allowRelations: false,
    }).filter((f) => f.rule === 'no-relation')
    expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
    for (const [name, source] of sources) {
      expect(source, `${name} 里出现了 @relation`).not.toContain('@relation')
    }
  })

  it('整份 schema 一条违规都没有', () => {
    const findings = lintSchemaConventions(ast, {
      enumExemptions: ENUM_EXEMPTIONS,
      allowRelations: false,
    })
    expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
  })
})

describe('租户模型注册表 ↔ schema 双向比对（蓝图 spec 1）', () => {
  it('零差异且哨兵有效', () => {
    const result = verifySchema({
      schemaDirs: [SCHEMA_DIR],
      registered: BASE_TENANT_MODELS,
      allowlist: BASE_PLATFORM_ALLOWLIST,
    })
    expect(result.sentinelOk).toBe(true)
    expect(result.ok, formatVerifySchemaReport(result)).toBe(true)
    expect(result.missingInRegistry).toEqual([])
    expect(result.missingInSchema).toEqual([])
    expect(result.nullableTenantId).toEqual([])
    expect(result.invalidAllowlist).toEqual([])
  })

  it('BASE_TENANT_MODELS 与 schema 里带 tenantId 的表逐一对上', () => {
    expect([...BASE_TENANT_MODELS].sort()).toEqual(tenantModels.map((m) => m.name).sort())
  })

  it('平台域白名单里的每一条都写了理由（当前为空是设计目标）', () => {
    for (const entry of BASE_PLATFORM_ALLOWLIST) {
      expect(entry.reason.trim().length, `${entry.model} 的白名单理由不能为空`).toBeGreaterThan(0)
    }
  })

  it('平台域基础设施表用 originTenantId / targetTenantId，不用可空 tenantId', () => {
    for (const name of ['JobDeadLetter', 'OutboxEvent']) {
      const model = ast.models.find((m) => m.name === name) as PrismaModel
      expect(model.fields.some((f) => f.name === 'tenantId')).toBe(false)
      expect(model.fields.some((f) => f.name === 'originTenantId' && f.optional)).toBe(true)
    }
    for (const name of ['PlatformAuditLog', 'PlatformNotifyRecord']) {
      const model = ast.models.find((m) => m.name === name) as PrismaModel
      expect(model.fields.some((f) => f.name === 'tenantId')).toBe(false)
      expect(model.fields.some((f) => f.name === 'targetTenantId' && f.optional)).toBe(true)
    }
  })
})

describe('蓝图 spec 11（前半）：加密列注册表 ↔ schema 对账', () => {
  it('注册表里的每一列在 schema 里都存在，且配对的 keyId 列也存在', () => {
    for (const entry of ENCRYPTED_COLUMNS) {
      const model = ast.models.find((m) => m.name === entry.model)
      expect(model, `注册表里的 ${entry.model} 在 schema 里不存在`).toBeDefined()
      const names = (model as PrismaModel).fields.map((f) => f.name)
      expect(names, `${entry.model}.${entry.column} 不存在`).toContain(entry.column)
      expect(names, `${entry.model}.${entry.keyIdColumn} 不存在`).toContain(entry.keyIdColumn)
    }
  })

  it('schema 里每个 *Enc 列都登记在注册表里（漏登记 = 轮换漏列）', () => {
    const registered = new Set(ENCRYPTED_COLUMNS.map((e) => `${e.model}.${e.column}`))
    const found: string[] = []
    for (const model of ast.models) {
      for (const field of model.fields) {
        if (field.name.endsWith(ENCRYPTED_COLUMN_SUFFIX)) found.push(`${model.name}.${field.name}`)
      }
    }
    expect(found.length).toBeGreaterThan(0)
    for (const column of found) {
      expect(registered, `${column} 没登记进 ENCRYPTED_COLUMNS`).toContain(column)
    }
    expect(found.sort()).toEqual([...registered].sort())
  })

  it('密文列都是 String（@db.Text），keyId 列与密文列的可空性一致', () => {
    for (const entry of ENCRYPTED_COLUMNS) {
      const model = ast.models.find((m) => m.name === entry.model) as PrismaModel
      const enc = model.fields.find((f) => f.name === entry.column)
      const keyId = model.fields.find((f) => f.name === entry.keyIdColumn)
      expect(enc?.type).toBe('String')
      expect(enc?.attributes).toContain('@db.Text')
      expect(keyId?.type).toBe('String')
      expect(
        keyId?.optional,
        `${entry.model}: ${entry.column} 与 ${entry.keyIdColumn} 的可空性必须一致，` +
          '否则会出现「有密文没版本号」的行',
      ).toBe(enc?.optional)
    }
  })

  it('每条登记都写了用途说明', () => {
    for (const entry of ENCRYPTED_COLUMNS) {
      expect(entry.description.trim().length).toBeGreaterThan(0)
    }
  })
})
