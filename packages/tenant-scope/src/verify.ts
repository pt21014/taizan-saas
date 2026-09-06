/**
 * `TENANT_MODELS` ↔ `*.prisma` 的双向比对器。
 *
 * 守的是这条：**漏登记 = 静默跨租户泄漏**。新加一张带 `tenantId` 的表却忘了 register，
 * 那张表将完全没有隔离——不会有任何报错，只会在某天变成租户之间串数据的事故
 * （xiaodian 2026-08 的真实事故就是这么来的）。
 *
 * 比对是双向的，两个方向漏一个都不行：
 * - schema 里带 `tenantId` 却没登记 → `missingInRegistry`（该表毫无隔离）；
 * - 登记了但 schema 里没有该列 → `missingInSchema`（清单里留了已删的表名，或写错了名字，
 *   而写错名字的后果是那张表实际上没被隔离）。
 *
 * 另外内置「**正则失效防假通过**」哨兵：解析器先在一段内置的、答案已知的 schema 文本上
 * 跑一遍，解析不出预期结果就 `sentinelOk = false`。没有这道哨兵的话，解析器一旦被 Prisma
 * 语法变化搞失效，比对会「一个问题都没有」地全绿——比根本不校验更危险。
 *
 * 只用 `node:fs` / `node:path`，零 npm 依赖。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { TenantScopeError } from './errors'

/** 从 `.prisma` 里解析出的一个 model / view 的信息。 */
export interface PrismaModelInfo {
  /** 模型名。 */
  name: string
  /** 块类型：`model` 或 `view`（两者都可能带 `tenantId`）。 */
  kind: 'model' | 'view'
  /** `tenantId` 字段的存在形态。 */
  tenantId: 'none' | 'required' | 'nullable'
}

/** schema 文本解析器签名。`verifySchema` 允许注入，仅用于在测试里模拟解析器失效。 */
export type PrismaSchemaParser = (source: string) => PrismaModelInfo[]

/** 带 `tenantId` 却刻意不隔离的表，必须写明理由。 */
export interface TenantModelAllowlistEntry {
  /** 模型名。 */
  model: string
  /** 为什么这张表不进隔离清单。空串 / 空白视为无效，会让校验失败。 */
  reason: string
}

/** allowlist 里有问题的条目。 */
export interface InvalidAllowlistEntry {
  /** 出问题的模型名（无法识别时为 `'(空)'`）。 */
  model: string
  /** 中文问题描述。 */
  problem: string
}

/** {@link verifySchema} 的入参。 */
export interface VerifySchemaOptions {
  /** `.prisma` 文件所在目录（会递归）或直接给 `.prisma` 文件路径。 */
  schemaDirs: readonly string[]
  /** 当前登记的租户域模型。 */
  registered: ReadonlySet<string> | readonly string[]
  /** 带 `tenantId` 但刻意不隔离的表 + 理由。 */
  allowlist?: readonly TenantModelAllowlistEntry[]
  /** 解析器注入口，**仅供测试模拟哨兵失效**，业务代码不要传。 */
  parser?: PrismaSchemaParser
}

/** {@link verifySchema} 的结果。 */
export interface VerifySchemaResult {
  /** 全部检查是否通过。CI / CLI 只看这一个字段决定退出码。 */
  ok: boolean
  /** 解析器哨兵是否通过。为 `false` 时其余结论一律不可信。 */
  sentinelOk: boolean
  /** 实际扫到并解析了的文件（绝对路径，已排序）。 */
  scannedFiles: string[]
  /** schema 里所有带 `tenantId` 的模型（含 allowlist 里的）。 */
  modelsWithTenantId: string[]
  /** 带 `tenantId` 却没登记、也不在 allowlist 里的模型：**这些表毫无隔离**。 */
  missingInRegistry: string[]
  /** 登记了但 schema 里查无此列的模型：清单陈旧或名字写错。 */
  missingInSchema: string[]
  /** `tenantId` 可空的模型：可空归属等于隔离有例外，蓝图 §3.1 明令禁止。 */
  nullableTenantId: string[]
  /** allowlist 里无效的条目（理由为空、重复、或 schema 里根本没这张表）。 */
  invalidAllowlist: InvalidAllowlistEntry[]
  /** 给了却读不到 / 里面一个 `.prisma` 都没有的路径。 */
  unreadable: string[]
}

/**
 * 「正则失效防假通过」哨兵用的内置 schema 文本：答案是写死的，解析器必须解得出来。
 *
 * 刻意塞了三种容易把解析器带沟里的写法：注释掉的字段、`@@index([tenantId, id])`
 * 这种在块级属性里出现的 `tenantId`、以及 `view` 块。
 */
export const SENTINEL_SCHEMA = `
model SentinelScoped {
  id        String   @id
  tenantId  String
  name      String
  createdAt DateTime @default(now())

  @@index([tenantId, id])
}

model SentinelGlobal {
  id   String @id
  // tenantId String  —— 注释掉的字段不算数
  code String @unique

  @@index([code])
}

view SentinelScopedView {
  id       String @id
  tenantId String
}
`

/** 哨兵的正确答案：全部块名。 */
const SENTINEL_ALL = ['SentinelGlobal', 'SentinelScoped', 'SentinelScopedView']
/** 哨兵的正确答案：带 tenantId 的块名。 */
const SENTINEL_SCOPED = ['SentinelScoped', 'SentinelScopedView']

const BLOCK_START = /^\s*(model|view)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/
const BLOCK_END = /^\s*\}\s*$/
const FIELD_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?/

/** 去掉行尾的 `//` 注释，但不碰引号里的 `//`（例如 `@default("http://x")`）。 */
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
 * 解析一段 `.prisma` 文本，取出所有 `model` / `view` 块及其 `tenantId` 形态。
 *
 * 用逐行状态机而不是一整个跨行正则：`[\s\S]*?\n\}` 那种写法遇到块级属性、嵌套括号、
 * CRLF 换行都可能整块漏掉，而漏掉的表恰恰就是「没被隔离」的表。
 *
 * @param source - `.prisma` 文件内容
 * @returns 解析到的模型信息数组，按出现顺序
 */
export function parsePrismaModels(source: string): PrismaModelInfo[] {
  const found: PrismaModelInfo[] = []
  let current: PrismaModelInfo | undefined

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripLineComment(rawLine)

    if (current === undefined) {
      const start = BLOCK_START.exec(line)
      if (start !== null && start[1] !== undefined && start[2] !== undefined) {
        current = { name: start[2], kind: start[1] === 'view' ? 'view' : 'model', tenantId: 'none' }
      }
      continue
    }

    if (BLOCK_END.test(line)) {
      found.push(current)
      current = undefined
      continue
    }

    const field = FIELD_LINE.exec(line)
    if (field !== null && field[1] === 'tenantId') {
      current.tenantId = field[4] === '?' ? 'nullable' : 'required'
    }
  }

  return found
}

/**
 * 在内置的、答案已知的 schema 文本上跑一遍解析器，确认它还工作。
 *
 * @param parser - 待检验的解析器，默认 {@link parsePrismaModels}
 * @returns 解析结果与内置答案完全一致时为 `true`
 */
export function runParserSentinel(parser: PrismaSchemaParser = parsePrismaModels): boolean {
  let parsed: PrismaModelInfo[]
  try {
    parsed = parser(SENTINEL_SCHEMA)
  } catch {
    return false
  }
  if (!Array.isArray(parsed)) return false

  const all = parsed.map((m) => m.name).sort()
  const scoped = parsed
    .filter((m) => m.tenantId === 'required')
    .map((m) => m.name)
    .sort()

  return (
    all.length === SENTINEL_ALL.length &&
    all.every((name, i) => name === SENTINEL_ALL[i]) &&
    scoped.length === SENTINEL_SCOPED.length &&
    scoped.every((name, i) => name === SENTINEL_SCOPED[i])
  )
}

/** 递归收集一个路径下的全部 `.prisma` 文件。 */
function collectPrismaFiles(target: string, out: string[]): void {
  const stat = statSync(target)
  if (stat.isFile()) {
    if (target.endsWith('.prisma')) out.push(target)
    return
  }
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(target).sort()) {
    collectPrismaFiles(join(target, entry), out)
  }
}

/**
 * 比对 schema 与租户模型注册表。
 *
 * @param options - 见 {@link VerifySchemaOptions}
 * @returns 双向比对结果 {@link VerifySchemaResult}；`ok` 为 `false` 时 CI 必须红
 * @throws {@link TenantScopeError} `INVALID_ARGUMENT`（一个 schema 路径都没给）
 *
 * @example
 * ```ts
 * const result = verifySchema({
 *   schemaDirs: ['prisma/schema'],
 *   registered: TENANT_MODELS,
 *   allowlist: [{ model: 'Plan', reason: '平台商品，全平台共享一份' }],
 * })
 * expect(result.ok, formatVerifySchemaReport(result)).toBe(true)
 * ```
 */
export function verifySchema(options: VerifySchemaOptions): VerifySchemaResult {
  const { schemaDirs, allowlist = [], parser = parsePrismaModels } = options

  if (schemaDirs.length === 0) {
    throw new TenantScopeError('INVALID_ARGUMENT', 'verifySchema 至少需要一个 schema 路径。')
  }

  const registered = new Set(options.registered)
  const sentinelOk = runParserSentinel(parser)

  const scannedFiles: string[] = []
  const unreadable: string[] = []
  for (const dir of schemaDirs) {
    const abs = resolve(dir)
    try {
      const before = scannedFiles.length
      collectPrismaFiles(abs, scannedFiles)
      if (scannedFiles.length === before) unreadable.push(abs)
    } catch {
      unreadable.push(abs)
    }
  }
  scannedFiles.sort()

  const withTenantId = new Set<string>()
  const nullable = new Set<string>()
  for (const file of scannedFiles) {
    for (const model of parser(readFileSync(file, 'utf8'))) {
      if (model.tenantId === 'required') withTenantId.add(model.name)
      if (model.tenantId === 'nullable') {
        withTenantId.add(model.name)
        nullable.add(model.name)
      }
    }
  }

  const invalidAllowlist: InvalidAllowlistEntry[] = []
  const allowed = new Set<string>()
  for (const entry of allowlist) {
    const model = typeof entry?.model === 'string' && entry.model.trim() !== '' ? entry.model : ''
    if (model === '') {
      invalidAllowlist.push({ model: '(空)', problem: 'allowlist 条目缺少 model 字段' })
      continue
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      invalidAllowlist.push({ model, problem: '白名单必须写明为什么这张表不隔离，reason 不能为空' })
      continue
    }
    if (allowed.has(model)) {
      invalidAllowlist.push({ model, problem: 'allowlist 里重复出现' })
      continue
    }
    if (!withTenantId.has(model)) {
      invalidAllowlist.push({
        model,
        problem: 'schema 里没有这张带 tenantId 的表，白名单条目已过期，请删掉',
      })
      continue
    }
    if (registered.has(model)) {
      invalidAllowlist.push({ model, problem: '同时出现在注册表和白名单里，二选一' })
      continue
    }
    allowed.add(model)
  }

  const missingInRegistry = [...withTenantId]
    .filter((name) => !registered.has(name) && !allowed.has(name))
    .sort()
  const missingInSchema = [...registered].filter((name) => !withTenantId.has(name)).sort()

  const result: VerifySchemaResult = {
    ok: false,
    sentinelOk,
    scannedFiles,
    modelsWithTenantId: [...withTenantId].sort(),
    missingInRegistry,
    missingInSchema,
    nullableTenantId: [...nullable].sort(),
    invalidAllowlist,
    unreadable,
  }
  result.ok =
    sentinelOk &&
    unreadable.length === 0 &&
    scannedFiles.length > 0 &&
    missingInRegistry.length === 0 &&
    missingInSchema.length === 0 &&
    nullable.size === 0 &&
    invalidAllowlist.length === 0

  return result
}

/**
 * 把 {@link verifySchema} 的结果渲染成中文清单，给 CLI 与 spec 的失败信息用。
 *
 * @param result - 校验结果
 * @returns 多行中文报告
 */
export function formatVerifySchemaReport(result: VerifySchemaResult): string {
  const lines: string[] = []
  lines.push(
    `扫描到 ${result.scannedFiles.length} 个 .prisma 文件，` +
      `其中带 tenantId 的模型 ${result.modelsWithTenantId.length} 个。`,
  )

  if (!result.sentinelOk) {
    lines.push('')
    lines.push('✗ 解析器哨兵失效：内置的已知 schema 文本都解析不出预期结果。')
    lines.push('  在修好解析器之前，下面的比对结论一律不可信（可能是「假通过」）。')
  }
  if (result.unreadable.length > 0) {
    lines.push('')
    lines.push('✗ 这些 schema 路径读不到、或里面一个 .prisma 都没有：')
    for (const path of result.unreadable) lines.push(`  - ${path}`)
  }
  if (result.scannedFiles.length === 0) {
    lines.push('')
    lines.push('✗ 一个 .prisma 文件都没扫到：路径大概率指错了，这种「全绿」不算数。')
  }
  if (result.missingInRegistry.length > 0) {
    lines.push('')
    lines.push('✗ 这些表有 tenantId 但没登记进 TENANT_MODELS —— 它们目前毫无租户隔离：')
    for (const model of result.missingInRegistry) lines.push(`  - ${model}`)
    lines.push('  处理：registry.register([...]) 补上；确属平台域表则写进 allowlist 并附理由。')
  }
  if (result.missingInSchema.length > 0) {
    lines.push('')
    lines.push('✗ 这些表登记了，但 schema 里查无 tenantId 列（清单陈旧或名字写错）：')
    for (const model of result.missingInSchema) lines.push(`  - ${model}`)
  }
  if (result.nullableTenantId.length > 0) {
    lines.push('')
    lines.push('✗ 这些表的 tenantId 可空 —— 可空归属等于隔离有例外（蓝图 §3.1 禁止，请拆表）：')
    for (const model of result.nullableTenantId) lines.push(`  - ${model}`)
  }
  if (result.invalidAllowlist.length > 0) {
    lines.push('')
    lines.push('✗ allowlist 条目无效：')
    for (const entry of result.invalidAllowlist) lines.push(`  - ${entry.model}：${entry.problem}`)
  }
  if (result.ok) {
    lines.push('')
    lines.push('✓ 租户模型注册表与 schema 双向一致，解析器哨兵正常。')
  }

  return lines.join('\n')
}
