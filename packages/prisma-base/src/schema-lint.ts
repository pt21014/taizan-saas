/**
 * `.prisma` 的结构化解析 + 数据约定静态检查。
 *
 * 蓝图 §3.1 那张「不可协商」的约定表，靠自觉是守不住的——一年后加表的人不会去翻文档。
 * 所以把每一条都写成可执行的断言（对应蓝图 spec 9 / spec 10），由本包与业务项目共用：
 * 业务项目在自己的 `schema.spec.ts` 里对 `prisma/schema` 跑一遍 {@link lintSchemaConventions}，
 * 新加的业务表一样受约束。
 *
 * 解析器刻意写成逐行状态机而不是跨行大正则：`[\s\S]*?\}` 这种写法遇到块级属性、
 * 嵌套括号、CRLF 都可能整块漏掉，而**漏掉的表恰恰就是没被检查的表**。
 * 与之配套，{@link runSchemaLintSentinel} 在一段答案已知的文本上先跑一遍，
 * 解析器失效时直接判红，而不是「一个问题都没有」地假通过。
 *
 * 只用字符串处理，不 import 任何 npm 包。
 */

/** 一个字段。 */
export interface PrismaField {
  /** 字段名。 */
  name: string
  /** 类型名（去掉 `[]` 与 `?`）。 */
  type: string
  /** 是否可空。 */
  optional: boolean
  /** 是否列表。 */
  list: boolean
  /** 类型后面那串属性原文，例如 `@id @db.VarChar(26)`。 */
  attributes: string
  /** 是否 `@id`。 */
  isId: boolean
  /** 是否字段级 `@unique`。 */
  isUnique: boolean
}

/** 一个 model / view 块。 */
export interface PrismaModel {
  /** 模型名。 */
  name: string
  /** 块类型。 */
  kind: 'model' | 'view'
  /** 所在文件名（调用方传入，用于报错定位）。 */
  file: string
  /** 全部字段，按出现顺序。 */
  fields: PrismaField[]
  /** 全部块级属性原文，例如 `@@index([tenantId, id])`。 */
  blockAttributes: string[]
}

/** 一个 enum 块。 */
export interface PrismaEnum {
  /** enum 名。 */
  name: string
  /** 所在文件名。 */
  file: string
  /** 取值列表。 */
  values: string[]
}

/** 一份（或多份）schema 的解析结果。 */
export interface PrismaSchemaAst {
  /** 全部 model / view。 */
  models: PrismaModel[]
  /** 全部 enum。 */
  enums: PrismaEnum[]
}

const BLOCK_START = /^\s*(model|view|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/
const BLOCK_END = /^\s*\}\s*$/
const FIELD_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?\s*(.*)$/
const ENUM_VALUE_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/

/** 去掉行尾 `//` 注释，但不碰引号里的 `//`（例如 `@default("http://x")`）。 */
function stripLineComment(line: string): string {
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

/**
 * 解析一段 `.prisma` 文本。
 *
 * @param source - 文件内容
 * @param file - 文件名，只用于报错时指路
 * @returns 解析出的 model / view / enum
 */
export function parsePrismaSchema(source: string, file = '(inline)'): PrismaSchemaAst {
  const models: PrismaModel[] = []
  const enums: PrismaEnum[] = []
  let model: PrismaModel | undefined
  let enumBlock: PrismaEnum | undefined

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripLineComment(rawLine)

    if (model === undefined && enumBlock === undefined) {
      const start = BLOCK_START.exec(line)
      if (start === null) continue
      const [, kind, name] = start as unknown as [string, string, string]
      if (kind === 'enum') enumBlock = { name, file, values: [] }
      else
        model = {
          name,
          kind: kind === 'view' ? 'view' : 'model',
          file,
          fields: [],
          blockAttributes: [],
        }
      continue
    }

    if (BLOCK_END.test(line)) {
      if (model !== undefined) models.push(model)
      if (enumBlock !== undefined) enums.push(enumBlock)
      model = undefined
      enumBlock = undefined
      continue
    }

    if (enumBlock !== undefined) {
      const value = ENUM_VALUE_LINE.exec(line)
      if (value !== null && value[1] !== undefined) enumBlock.values.push(value[1])
      continue
    }

    if (model === undefined) continue

    const trimmed = line.trim()
    if (trimmed.startsWith('@@')) {
      model.blockAttributes.push(trimmed)
      continue
    }
    if (trimmed === '' || trimmed.startsWith('/')) continue

    const field = FIELD_LINE.exec(line)
    if (field === null) continue
    const attributes = (field[5] ?? '').trim()
    model.fields.push({
      name: field[1] as string,
      type: field[2] as string,
      list: field[3] === '[]',
      optional: field[4] === '?',
      attributes,
      isId: /(^|\s)@id(\s|$|\()/.test(attributes),
      isUnique: /(^|\s)@unique(\s|$|\()/.test(attributes),
    })
  }

  return { models, enums }
}

/**
 * 「解析器失效防假通过」哨兵用的文本：答案写死在下面的常量里，解析器必须解得出来。
 *
 * 刻意塞了几种最容易把逐行解析器带沟里的写法：`///` 文档注释、注释掉的字段、
 * 块级属性里出现的字段名、native type 里的括号、以及紧跟在 model 后面的 enum 块。
 */
export const LINT_SENTINEL_SCHEMA = `
/// 哨兵模型
model SentinelRow {
  id        String   @id @db.VarChar(26)
  tenantId  String   @db.VarChar(26)
  // deletedAt DateTime?  —— 注释掉的字段不算数
  priceCents Int
  status    SentinelStatus @default(OK)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([tenantId, priceCents])
  @@index([tenantId, id])
}

enum SentinelStatus {
  OK
  BAD
}
`

/**
 * 在内置的、答案已知的文本上跑一遍解析器，确认它还工作。
 *
 * @param parser - 待检验的解析器，默认 {@link parsePrismaSchema}
 * @returns 解析结果与内置答案完全一致时为 `true`
 */
export function runSchemaLintSentinel(
  parser: (source: string, file?: string) => PrismaSchemaAst = parsePrismaSchema,
): boolean {
  let ast: PrismaSchemaAst
  try {
    ast = parser(LINT_SENTINEL_SCHEMA, '(sentinel)')
  } catch {
    return false
  }
  if (ast.models.length !== 1 || ast.enums.length !== 1) return false
  const model = ast.models[0] as PrismaModel
  const names = model.fields.map((f) => f.name)
  return (
    model.name === 'SentinelRow' &&
    names.join(',') === 'id,tenantId,priceCents,status,createdAt,updatedAt' &&
    model.fields[0]?.isId === true &&
    model.fields[0]?.type === 'String' &&
    model.fields[3]?.type === 'SentinelStatus' &&
    model.blockAttributes.length === 2 &&
    model.blockAttributes[0] === '@@unique([tenantId, priceCents])' &&
    (ast.enums[0] as PrismaEnum).values.join(',') === 'OK,BAD'
  )
}

/** 一条违规。 */
export interface SchemaLintFinding {
  /** 违反了哪条规则（对应蓝图 spec 编号 / §3.1 条目）。 */
  rule:
    | 'no-decimal'
    | 'money-cents'
    | 'id-string'
    | 'enum-status'
    | 'tenant-index'
    | 'soft-delete-unique'
    | 'timestamps'
    | 'no-map'
    | 'no-relation'
  /** 模型名。 */
  model: string
  /** 文件名。 */
  file: string
  /** 中文说明。 */
  message: string
}

/** 「名字里带这些词的数值列必须是 `*Cents Int`」。 */
const MONEY_WORDS = ['price', 'amount', 'fee', 'balance']

/** 数值类型。 */
const NUMERIC_TYPES = new Set(['Int', 'BigInt', 'Float', 'Decimal'])

/** 必须是 enum 的列名（精确匹配，大小写不敏感）。 */
const ENUM_EXACT_NAMES = new Set(['status', 'type', 'kind'])

/** 必须是 enum 的列名后缀。 */
const ENUM_SUFFIXES = ['Status', 'Type', 'Kind']

/** {@link lintSchemaConventions} 的入参。 */
export interface SchemaLintOptions {
  /**
   * 允许不是 enum 的「状态类」列，必须写理由。
   *
   * 唯一的合法场景是「值域由业务实体名构成的自由文本」，例如审计日志的 `targetType`
   * ——它存的是业务模型名，做成 enum 等于每加一张业务表就要改框架 schema。
   */
  enumExemptions?: readonly { model: string; field: string; reason: string }[]
  /** 是否允许 relation 字段。框架基础表传 `false`（一条 relation 都不写）。 */
  allowRelations?: boolean
}

/**
 * 按蓝图 §3.1 / spec 9 / spec 10 检查一批 model。
 *
 * 逐条对应关系：
 * - `no-decimal` / `money-cents` → spec 9：禁 Decimal；名含 price/amount/fee/balance 的
 *   数值列必须 `Cents` 结尾且是 Int。金额口径打架的对账事故就是这么来的。
 * - `id-string` → spec 10：所有 `@id` 必须是 String（ULID 应用层生成）。
 * - `enum-status` → spec 10：状态类列必须是 enum，禁止裸 Int/String。
 * - `tenant-index` → spec 10：带 `tenantId` 的表必须有 `@@index([tenantId, id])`。
 * - `soft-delete-unique` → spec 10：有 `deletedAt` 的表，唯一索引必须带 `deletedAt`
 *   （否则软删完再建同名记录会撞唯一键），且不许有字段级 `@unique`。
 * - `timestamps` → §3.1：`createdAt` / `updatedAt` 必备。
 * - `no-map` → §3.1：camelCase 直用，不做 `@map` / `@@map`。
 * - `no-relation` → §3.1：不建指向 Tenant 的外键；框架基础表索性一条 relation 都不建。
 *
 * @param ast - {@link parsePrismaSchema} 的结果（可以是多个文件合并后的）
 * @param options - 见 {@link SchemaLintOptions}
 * @returns 全部违规，空数组表示通过
 */
export function lintSchemaConventions(
  ast: PrismaSchemaAst,
  options: SchemaLintOptions = {},
): SchemaLintFinding[] {
  const { enumExemptions = [], allowRelations = true } = options
  const enumNames = new Set(ast.enums.map((e) => e.name))
  const modelNames = new Set(ast.models.map((m) => m.name))
  const exempt = new Set(enumExemptions.map((e) => `${e.model}.${e.field}`))
  const findings: SchemaLintFinding[] = []

  const push = (rule: SchemaLintFinding['rule'], model: PrismaModel, message: string): void =>
    void findings.push({ rule, model: model.name, file: model.file, message })

  for (const model of ast.models) {
    const fieldNames = new Set(model.fields.map((f) => f.name))
    const hasTenantId = fieldNames.has('tenantId')
    const hasDeletedAt = fieldNames.has('deletedAt')
    const ids = model.fields.filter((f) => f.isId)

    if (ids.length !== 1) {
      push('id-string', model, `必须恰好有一个 @id 字段，实际 ${ids.length} 个。`)
    }
    for (const id of ids) {
      if (id.type !== 'String') {
        push('id-string', model, `主键 ${id.name} 是 ${id.type}，必须是 String（ULID）。`)
      }
    }

    for (const field of model.fields) {
      if (field.type === 'Decimal') {
        push('no-decimal', model, `${field.name} 用了 Decimal；金额一律 Int + *Cents。`)
      }

      const lower = field.name.toLowerCase()
      if (NUMERIC_TYPES.has(field.type) && MONEY_WORDS.some((w) => lower.includes(w))) {
        if (!field.name.endsWith('Cents')) {
          push(
            'money-cents',
            model,
            `${field.name} 是金额类数值列，字段名必须以 Cents 结尾（当前 ${field.name}）。`,
          )
        } else if (field.type !== 'Int') {
          push('money-cents', model, `${field.name} 必须是 Int，当前是 ${field.type}。`)
        }
      }

      const needsEnum =
        ENUM_EXACT_NAMES.has(lower) || ENUM_SUFFIXES.some((s) => field.name.endsWith(s))
      if (needsEnum && !enumNames.has(field.type) && !exempt.has(`${model.name}.${field.name}`)) {
        push(
          'enum-status',
          model,
          `${field.name} 是状态类列，类型必须是 enum，当前是 ${field.type}；` +
            `确有理由用自由文本请登记进 enumExemptions 并写明原因。`,
        )
      }

      if (field.attributes.includes('@map(')) {
        push('no-map', model, `${field.name} 用了 @map；约定 camelCase 直用，不做映射。`)
      }

      if (!allowRelations && modelNames.has(field.type)) {
        push(
          'no-relation',
          model,
          `${field.name} 指向模型 ${field.type}：框架基础表不建 relation（将来平台侧要能拆成独立服务）。`,
        )
      }

      if (hasDeletedAt && field.isUnique) {
        push(
          'soft-delete-unique',
          model,
          `${field.name} 是字段级 @unique，但本表有 deletedAt：` +
            `软删后再建同名记录会撞唯一键，请改成带 deletedAt 的 @@unique。`,
        )
      }
    }

    for (const attribute of model.blockAttributes) {
      if (attribute.startsWith('@@map(')) {
        push('no-map', model, '用了 @@map；约定表名直用模型名。')
      }
      if (hasDeletedAt && attribute.startsWith('@@unique(') && !attribute.includes('deletedAt')) {
        push(
          'soft-delete-unique',
          model,
          `唯一索引 ${attribute} 没带 deletedAt，软删后重建同名记录会撞唯一键。`,
        )
      }
    }

    if (
      hasTenantId &&
      !model.blockAttributes.some((a) => a.replace(/\s+/g, '') === '@@index([tenantId,id])')
    ) {
      push('tenant-index', model, '租户表必须有 @@index([tenantId, id])。')
    }

    for (const required of ['createdAt', 'updatedAt']) {
      if (!fieldNames.has(required)) {
        push('timestamps', model, `缺少 ${required}（§3.1：createdAt / updatedAt 必备）。`)
      }
    }
    const updatedAt = model.fields.find((f) => f.name === 'updatedAt')
    if (updatedAt !== undefined && !updatedAt.attributes.includes('@updatedAt')) {
      push('timestamps', model, 'updatedAt 必须带 @updatedAt，否则它永远不会变。')
    }
    const createdAt = model.fields.find((f) => f.name === 'createdAt')
    if (createdAt !== undefined && !createdAt.attributes.includes('@default(now())')) {
      push('timestamps', model, 'createdAt 必须带 @default(now())。')
    }
  }

  return findings
}

/**
 * 把违规渲染成中文清单，给 spec 的失败信息用。
 *
 * @param findings - {@link lintSchemaConventions} 的结果
 * @returns 多行中文报告
 */
export function formatSchemaLintReport(findings: readonly SchemaLintFinding[]): string {
  if (findings.length === 0) return '✓ schema 数据约定检查通过。'
  return [
    `✗ schema 数据约定检查发现 ${findings.length} 处违规：`,
    ...findings.map((f) => `  - [${f.rule}] ${f.file} ${f.model}：${f.message}`),
  ].join('\n')
}
