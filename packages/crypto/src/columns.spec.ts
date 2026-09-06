import { describe, expect, it } from 'vitest'

import {
  DEFAULT_KEY_ID_OVERRIDES,
  formatEncryptedColumnsReport,
  keyIdColumnFor,
  parsePrismaModels,
  verifyEncryptedColumns,
  type EncryptedColumn,
} from './columns'
import { planRotation } from './rotate'

/**
 * 一段内嵌 schema，字段形状照抄 `packages/prisma-base/schema/` 里的三张真表。
 * 内嵌而不是去读文件：对账函数是纯函数，spec 要能自由构造四种差异场景。
 */
const SCHEMA = `
/// 租户级三方密钥。
model TenantCredential {
  id         String    @id @db.VarChar(26)
  tenantId   String    @db.VarChar(26)
  provider   String
  credKey    String
  /// 密文。明文永远不落库。
  valueEnc   String    @db.Text
  keyId      String
  maskedHint String?
  createdAt  DateTime  @default(now())
  deletedAt  DateTime?

  @@unique([tenantId, provider, credKey, deletedAt])
  @@index([tenantId, id])
}

/// 平台级设置。
model PlatformSetting {
  id        String   @id @db.VarChar(26)
  key       String   @unique
  value     Json
  valueEnc  String?  @db.Text
  keyId     String?
  createdAt DateTime @default(now())
}

/// 平台管理员。
model PlatformAdmin {
  id           String        @id @db.VarChar(26)
  username     String        @unique
  passwordHash String
  mfaSecretEnc String?       @db.Text
  mfaKeyId     String?
  createdAt    DateTime      @default(now())

  @@index([username])
}

/// 没有任何加密列的表，用来确认解析器不会误报。
model AuditLog {
  id        String   @id @db.VarChar(26)
  action    String
  createdAt DateTime @default(now())
}
`

/** 与内嵌 schema 完全对得上的注册表。 */
const REGISTRY: EncryptedColumn[] = [
  { model: 'TenantCredential', column: 'valueEnc', keyIdColumn: 'keyId', description: '租户密钥' },
  { model: 'PlatformSetting', column: 'valueEnc', keyIdColumn: 'keyId', description: '平台密钥' },
  {
    model: 'PlatformAdmin',
    column: 'mfaSecretEnc',
    keyIdColumn: 'mfaKeyId',
    description: 'TOTP 种子',
  },
]

/** 轮换覆盖列 = 计划里的 ref，与真实用法一致。 */
function coverageOf(registry: readonly EncryptedColumn[]): string[] {
  return planRotation(registry, 'k1', 'k2', { dryRun: true }).items.map((i) => i.ref)
}

describe('keyIdColumnFor 命名规则', () => {
  it('valueEnc 特例映射为 keyId', () => {
    expect(keyIdColumnFor('valueEnc')).toBe('keyId')
  })

  it('mfaSecretEnc 特例映射为 mfaKeyId', () => {
    expect(keyIdColumnFor('mfaSecretEnc')).toBe('mfaKeyId')
  })

  it('通用规则：去掉 Enc 后缀再加 KeyId', () => {
    expect(keyIdColumnFor('apiV3KeyEnc')).toBe('apiV3KeyKeyId')
    expect(keyIdColumnFor('privateKeyPemEnc')).toBe('privateKeyPemKeyId')
  })

  it('不以 Enc 结尾的列名按原名当基名（历史列名不带后缀的情况）', () => {
    expect(keyIdColumnFor('appSecret')).toBe('appSecretKeyId')
  })

  it('例外表可配置，业务项目可以传自己的一份', () => {
    expect(keyIdColumnFor('tokenEnc', { token: 'tokenKeyVersion' })).toBe('tokenKeyVersion')
  })

  it('传了自定义例外表就不再套用默认例外（value 不再映射成 keyId）', () => {
    expect(keyIdColumnFor('valueEnc', {})).toBe('valueKeyId')
  })

  it('默认例外表就是 value 与 mfaSecret 两条', () => {
    expect(Object.keys(DEFAULT_KEY_ID_OVERRIDES).sort()).toEqual(['mfaSecret', 'value'])
  })

  it('原型链上的键不会被误当成例外（hasOwnProperty 保护）', () => {
    expect(keyIdColumnFor('toStringEnc', {})).toBe('toStringKeyId')
  })
})

describe('parsePrismaModels 解析器', () => {
  const models = parsePrismaModels([SCHEMA])

  it('解析出四个 model', () => {
    expect(models.map((m) => m.name)).toEqual([
      'TenantCredential',
      'PlatformSetting',
      'PlatformAdmin',
      'AuditLog',
    ])
  })

  it('字段名解析正确，跳过 /// 注释与 @@ 块级指令', () => {
    const t = models.find((m) => m.name === 'TenantCredential')!
    expect(t.fields).toContain('valueEnc')
    expect(t.fields).toContain('keyId')
    expect(t.fields.some((f) => f.startsWith('@'))).toBe(false)
    expect(t.fields).not.toContain('unique')
  })

  it('字段类型去掉了 ? 与 []', () => {
    const p = models.find((m) => m.name === 'PlatformSetting')!
    expect(p.types.valueEnc).toBe('String')
    expect(p.types.value).toBe('Json')
  })

  it('多段 schema 文本可以一起喂进来（框架 schema 是拆成多个文件的）', () => {
    const split = parsePrismaModels([
      'model A {\n  id String @id\n}\n',
      'model B {\n  id String @id\n}\n',
    ])
    expect(split.map((m) => m.name)).toEqual(['A', 'B'])
  })

  it('连续调用不受全局正则 lastIndex 影响', () => {
    expect(parsePrismaModels([SCHEMA])).toHaveLength(4)
    expect(parsePrismaModels([SCHEMA])).toHaveLength(4)
  })
})

describe('verifyEncryptedColumns 三处对账', () => {
  it('哨兵：解析器必须真的解析出内嵌的已知列，否则本文件全是空跑', () => {
    const report = verifyEncryptedColumns({
      registry: REGISTRY,
      schemaText: [SCHEMA],
      rotationCoverage: coverageOf(REGISTRY),
    })
    expect(report.models.length).toBeGreaterThanOrEqual(4)
    expect(report.schemaColumns).toContain('TenantCredential.valueEnc')
    expect(report.schemaColumns).toContain('PlatformAdmin.mfaSecretEnc')
    expect(report.schemaColumns).toHaveLength(3)
    // 反向哨兵：没有加密列的表不许被扫成加密列
    expect(report.schemaColumns.some((c) => c.startsWith('AuditLog.'))).toBe(false)
  })

  it('哨兵：schema 文本被清空时对账必须判失败，而不是「全都对得上」', () => {
    const report = verifyEncryptedColumns({
      registry: REGISTRY,
      schemaText: [''],
      rotationCoverage: coverageOf(REGISTRY),
    })
    expect(report.models).toHaveLength(0)
    expect(report.ok).toBe(false)
    expect(report.missingInSchema).toHaveLength(3)
  })

  it('三处一致时 ok 为 true，五组差异全空', () => {
    const report = verifyEncryptedColumns({
      registry: REGISTRY,
      schemaText: [SCHEMA],
      rotationCoverage: coverageOf(REGISTRY),
    })
    expect(report.missingInSchema).toEqual([])
    expect(report.missingInRegistry).toEqual([])
    expect(report.missingKeyIdColumn).toEqual([])
    expect(report.missingInRotation).toEqual([])
    expect(report.unknownInRotation).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('差异一 · 注册表多一列（schema 里没有）', () => {
    const registry = [
      ...REGISTRY,
      { model: 'GhostTable', column: 'tokenEnc', keyIdColumn: 'tokenKeyId' },
    ]
    const report = verifyEncryptedColumns({
      registry,
      schemaText: [SCHEMA],
      rotationCoverage: coverageOf(registry),
    })
    expect(report.missingInSchema).toEqual(['GhostTable.tokenEnc'])
    expect(report.missingInRegistry).toEqual([])
    expect(report.ok).toBe(false)
  })

  it('差异二 · schema 多一列（漏登记，换密钥时整列被跳过）', () => {
    const registry = REGISTRY.slice(0, 2) // 把 PlatformAdmin.mfaSecretEnc 摘掉
    const report = verifyEncryptedColumns({
      registry,
      schemaText: [SCHEMA],
      rotationCoverage: coverageOf(registry),
    })
    expect(report.missingInRegistry).toEqual(['PlatformAdmin.mfaSecretEnc'])
    expect(report.missingInSchema).toEqual([])
    expect(report.ok).toBe(false)
  })

  it('差异三 · *Enc 列缺配对的 keyId 列', () => {
    const broken = SCHEMA.replace('  mfaKeyId     String?\n', '')
    const report = verifyEncryptedColumns({
      registry: REGISTRY,
      schemaText: [broken],
      rotationCoverage: coverageOf(REGISTRY),
    })
    expect(report.missingKeyIdColumn).toEqual([
      { ref: 'PlatformAdmin.mfaSecretEnc', expected: 'mfaKeyId' },
    ])
    expect(report.ok).toBe(false)
  })

  it('差异三 · 没登记的 *Enc 列缺 keyId 列时，期望列名走命名规则推导', () => {
    const extra = `${SCHEMA}
model TenantWebhook {
  id         String @id @db.VarChar(26)
  secretEnc  String @db.Text
}
`
    const report = verifyEncryptedColumns({
      registry: REGISTRY,
      schemaText: [extra],
      rotationCoverage: coverageOf(REGISTRY),
    })
    expect(report.missingKeyIdColumn).toEqual([
      { ref: 'TenantWebhook.secretEnc', expected: 'secretKeyId' },
    ])
    expect(report.missingInRegistry).toEqual(['TenantWebhook.secretEnc'])
  })

  it('差异四 · 轮换没覆盖到某一列（--only 常年漏掉，等于没登记）', () => {
    const report = verifyEncryptedColumns({
      registry: REGISTRY,
      schemaText: [SCHEMA],
      rotationCoverage: coverageOf(REGISTRY).filter((r) => r !== 'PlatformAdmin.mfaSecretEnc'),
    })
    expect(report.missingInRotation).toEqual(['PlatformAdmin.mfaSecretEnc'])
    expect(report.ok).toBe(false)
  })

  it('差异四反向 · 轮换覆盖了注册表里没有的列', () => {
    const report = verifyEncryptedColumns({
      registry: REGISTRY,
      schemaText: [SCHEMA],
      rotationCoverage: [...coverageOf(REGISTRY), 'Typo.valueEnc'],
    })
    expect(report.unknownInRotation).toEqual(['Typo.valueEnc'])
    expect(report.ok).toBe(false)
  })

  it('Json 类型的 *Enc 列不算本包的密文列（只认 String）', () => {
    const jsonEnc = `${SCHEMA}
model Weird {
  id      String @id
  blobEnc Json
}
`
    const report = verifyEncryptedColumns({
      registry: REGISTRY,
      schemaText: [jsonEnc],
      rotationCoverage: coverageOf(REGISTRY),
    })
    expect(report.schemaColumns).not.toContain('Weird.blobEnc')
    expect(report.ok).toBe(true)
  })

  it('keyIdOverrides 可以传自定义例外表', () => {
    const custom = `
model Thing {
  id       String @id
  tokenEnc String
  tokenKv  String
}
`
    const report = verifyEncryptedColumns({
      registry: [],
      schemaText: [custom],
      rotationCoverage: [],
      keyIdOverrides: { token: 'tokenKv' },
    })
    expect(report.missingKeyIdColumn).toEqual([])
    expect(report.missingInRegistry).toEqual(['Thing.tokenEnc'])
  })

  it('注册表登记的 keyIdColumn 优先于命名规则（真源是注册表）', () => {
    const custom = `
model Thing {
  id       String @id
  tokenEnc String
  weirdKey String
}
`
    const registry = [{ model: 'Thing', column: 'tokenEnc', keyIdColumn: 'weirdKey' }]
    const report = verifyEncryptedColumns({
      registry,
      schemaText: [custom],
      rotationCoverage: coverageOf(registry),
    })
    expect(report.ok).toBe(true)
  })

  it('差异清单已排序且去重，输出稳定', () => {
    const report = verifyEncryptedColumns({
      registry: [],
      schemaText: [SCHEMA],
      rotationCoverage: [],
    })
    expect(report.missingInRegistry).toEqual([
      'PlatformAdmin.mfaSecretEnc',
      'PlatformSetting.valueEnc',
      'TenantCredential.valueEnc',
    ])
  })
})

describe('formatEncryptedColumnsReport', () => {
  it('通过时回一行中文小结', () => {
    const report = verifyEncryptedColumns({
      registry: REGISTRY,
      schemaText: [SCHEMA],
      rotationCoverage: coverageOf(REGISTRY),
    })
    const lines = formatEncryptedColumnsReport(report)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('通过')
  })

  it('五类差异各渲染一行中文，能定位到具体列', () => {
    const registry = [
      ...REGISTRY.slice(0, 2),
      { model: 'GhostTable', column: 'tokenEnc', keyIdColumn: 'tokenKeyId' },
    ]
    const report = verifyEncryptedColumns({
      registry,
      schemaText: [SCHEMA.replace('  mfaKeyId     String?\n', '')],
      rotationCoverage: ['Typo.valueEnc'],
    })
    const text = formatEncryptedColumnsReport(report).join('\n')
    expect(text).toContain('GhostTable.tokenEnc')
    expect(text).toContain('PlatformAdmin.mfaSecretEnc')
    expect(text).toContain('Typo.valueEnc')
    expect(text).toContain('mfaKeyId')
  })
})
