/**
 * 加密列注册表的类型与**三处对账**纯函数（蓝图 §8 第 11 条 `credential-registry.spec.ts`）。
 *
 * 守的不变量只有一句：**密钥轮换漏列 = 换完密钥读不出来**。
 * 漏登记不会报错，只会在半年后某次轮换时炸成「部分租户支付全挂」，所以直接解析源码对账。
 *
 * 三处指的是：
 *
 * | # | 位置 | 漏了会怎样 |
 * |---|---|---|
 * | 1 | schema 里的 `*Enc` 列 | —— 真源 |
 * | 2 | 加密列注册表（`@taizan/prisma-base` 的 `ENCRYPTED_COLUMNS`） | 轮换脚本按注册表走，漏登记 = 这列永远轮换不到 |
 * | 3 | 轮换实际覆盖的列（`planRotation` 的产物） | 注册表登记了但 `--only` 常年漏掉，等于没登记 |
 *
 * 本包**刻意不 import `@taizan/prisma-base`**：加密内核要能在没有 prisma、没有数据库的
 * 裸 node 环境里跑单测，反过来依赖会把 Prisma 整条依赖链拖进来。这里定义同形状的
 * {@link EncryptedColumn}，由调用方（`credential-registry.spec.ts`）把 `ENCRYPTED_COLUMNS`
 * 喂进来。两处形状必须一致，字段含义逐字对应 `packages/prisma-base/src/encrypted-columns.ts`。
 */

/**
 * 一条加密列登记。
 *
 * 与 `@taizan/prisma-base` 的 `ENCRYPTED_COLUMNS: readonly EncryptedColumn[]` 同形状
 * （`description` 在那边是必填、在这里放宽为可选，好让业务项目临时拼一份最小注册表来跑轮换）。
 */
export interface EncryptedColumn {
  /** Prisma 模型名，例如 `TenantCredential`。 */
  model: string
  /** 密文列名，约定以 `Enc` 结尾，例如 `valueEnc`。 */
  column: string
  /** 与之配对的密钥版本号列名，例如 `keyId`。轮换时按它挑行、写回。 */
  keyIdColumn: string
  /** 这列存的是什么，给轮换脚本与安全审计看。 */
  description?: string
}

/** 密文列的命名约定后缀。与 `@taizan/prisma-base` 的 `ENCRYPTED_COLUMN_SUFFIX` 一致。 */
export const ENCRYPTED_COLUMN_SUFFIX = 'Enc'

/**
 * 无法由命名规则推导的 keyId 列名例外表。
 *
 * 键是**去掉 `Enc` 后缀之后**的基名，值是该列真正配对的 keyId 列名。
 *
 * 为什么需要例外表：通用规则「去掉 `Enc` 再加 `KeyId`」推 `mfaSecretEnc` 会得到
 * `mfaSecretKeyId`，而 schema 里写的是 `mfaKeyId`；`valueEnc` 推出来是 `valueKeyId`，
 * schema 里写的是 `keyId`。命名约定在真实 schema 里从来推不干净，与其把规则写成
 * 一串猜测，不如把例外显式列出来——**注册表里的 `keyIdColumn` 才是真源**，
 * {@link keyIdColumnFor} 只是给「schema 里冒出一列没登记的 `*Enc`」时推荐一个期望列名用。
 */
export const DEFAULT_KEY_ID_OVERRIDES: Readonly<Record<string, string>> = {
  /** `valueEnc` → `keyId`（TenantCredential / PlatformSetting）。 */
  value: 'keyId',
  /** `mfaSecretEnc` → `mfaKeyId`（PlatformAdmin）。 */
  mfaSecret: 'mfaKeyId',
}

/**
 * 由密文列名推出它**应该**配对的 keyId 列名。
 *
 * 规则（可配置，例外优先）：
 *
 * 1. 去掉 `Enc` 后缀得到基名，例如 `valueEnc` → `value`、`mfaSecretEnc` → `mfaSecret`；
 * 2. 基名命中 `overrides`（默认 {@link DEFAULT_KEY_ID_OVERRIDES}）就用例外表里的值：
 *    `value` → `keyId`、`mfaSecret` → `mfaKeyId`；
 * 3. 否则基名后接 `KeyId`，例如 `apiV3KeyEnc` → `apiV3KeyKeyId`。
 *
 * 业务项目如果有自己的命名习惯，传一份自己的 `overrides` 进来即可，不要改这里的默认表。
 *
 * @param column - 密文列名（通常以 `Enc` 结尾；不以 `Enc` 结尾时按原名当基名处理）
 * @param overrides - 例外表，键是去掉 `Enc` 后的基名
 * @returns 期望的 keyId 列名
 */
export function keyIdColumnFor(
  column: string,
  overrides: Readonly<Record<string, string>> = DEFAULT_KEY_ID_OVERRIDES,
): string {
  const base = column.endsWith(ENCRYPTED_COLUMN_SUFFIX)
    ? column.slice(0, -ENCRYPTED_COLUMN_SUFFIX.length)
    : column
  const hit = Object.prototype.hasOwnProperty.call(overrides, base) ? overrides[base] : undefined
  return hit ?? `${base}KeyId`
}

/** schema 里解析出来的一个模型。 */
export interface ParsedModel {
  /** 模型名。 */
  name: string
  /** 该模型的全部字段名（不含 `@@index` 这类块级指令）。 */
  fields: readonly string[]
  /** 字段名 → 字段类型（去掉 `?` 与 `[]`），例如 `valueEnc` → `String`。 */
  types: Readonly<Record<string, string>>
}

/** `Model.column` 形式的定位串。 */
export type ColumnRef = string

/** 一条「`*Enc` 列缺配对 keyId 列」的记录。 */
export interface MissingKeyIdEntry {
  /** 出问题的密文列，`Model.column`。 */
  ref: ColumnRef
  /** 期望存在的 keyId 列名（来自注册表登记，或 {@link keyIdColumnFor} 的推导）。 */
  expected: string
}

/** {@link verifyEncryptedColumns} 的入参。 */
export interface VerifyEncryptedColumnsInput {
  /** 加密列注册表，形状同 `@taizan/prisma-base` 的 `ENCRYPTED_COLUMNS`。 */
  registry: readonly EncryptedColumn[]
  /** 若干段 `.prisma` 源码文本。调用方自己读文件，本函数保持纯净、不碰 fs。 */
  schemaText: readonly string[]
  /**
   * 轮换脚本实际覆盖到的列，`Model.column` 形式。
   * 通常传 `planRotation(...).items.map((i) => i.ref)`。
   */
  rotationCoverage: readonly ColumnRef[]
  /** keyId 列名推导的例外表，默认 {@link DEFAULT_KEY_ID_OVERRIDES}。 */
  keyIdOverrides?: Readonly<Record<string, string>>
}

/** {@link verifyEncryptedColumns} 的产物。 */
export interface EncryptedColumnsReport {
  /** 三组差异全空才为 true。 */
  ok: boolean
  /** 解析出来的模型（哨兵断言用：解析器失效时这里会是空的）。 */
  models: readonly ParsedModel[]
  /** schema 里扫到的全部 `*Enc` String 列，`Model.column`，已排序。 */
  schemaColumns: readonly ColumnRef[]
  /** 注册表登记的全部列，`Model.column`，已排序。 */
  registryColumns: readonly ColumnRef[]

  /** 第一组差异 · 注册表有、schema 里没有（登记了不存在的列，多半是改名没同步）。 */
  missingInSchema: readonly ColumnRef[]
  /** 第一组差异 · schema 里有、注册表没有（漏登记，换密钥时这列会被跳过）。 */
  missingInRegistry: readonly ColumnRef[]

  /** 第二组差异 · `*Enc` 列没有配对的 keyId 列（换完密钥这行就分不清新旧）。 */
  missingKeyIdColumn: readonly MissingKeyIdEntry[]

  /** 第三组差异 · 注册表登记了、轮换没覆盖（等于没登记）。 */
  missingInRotation: readonly ColumnRef[]
  /** 第三组差异 · 轮换覆盖了、注册表里没有（`--only` 写错列名时会命中这条）。 */
  unknownInRotation: readonly ColumnRef[]
}

/** 匹配 `model X { … }` 块。`^\}` 配合 `m` 标志定住块尾，避免嵌套花括号吃过头。 */
const MODEL_BLOCK_RE = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm

/**
 * 解析 `.prisma` 文本里的 model 块。
 *
 * 只认「行首是标识符、第二个 token 是类型」的字段行，跳过注释（`//` `///`）、
 * 块级指令（`@@index` / `@@map`）与空行。
 *
 * @param schemaText - 若干段 schema 源码
 * @returns 解析出来的模型列表，按出现顺序
 */
export function parsePrismaModels(schemaText: readonly string[]): ParsedModel[] {
  const out: ParsedModel[] = []
  for (const text of schemaText) {
    // 全局正则跨次调用会带 lastIndex，每段文本前重置一次。
    MODEL_BLOCK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MODEL_BLOCK_RE.exec(text)) !== null) {
      const fields: string[] = []
      const types: Record<string, string> = {}
      for (const line of (m[2] ?? '').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith('@')) continue
        const tokens = trimmed.split(/\s+/)
        const name = tokens[0]
        if (!name || !/^\w+$/.test(name)) continue
        const rawType = tokens[1]
        if (!rawType) continue
        fields.push(name)
        // `String?` / `String[]` / `String` 统一成 `String`。
        types[name] = rawType.replace(/[?[\]]/g, '')
      }
      out.push({ name: m[1] ?? '', fields, types })
    }
  }
  return out
}

/** `Model.column` 定位串。 */
function refOf(model: string, column: string): ColumnRef {
  return `${model}.${column}`
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

/**
 * 三处对账：注册表 ↔ schema 的 `*Enc` 列 ↔ 轮换覆盖列。
 *
 * 纯函数，不读文件、不连库，方便在 spec 里用一段内嵌 schema 文本反复构造差异场景。
 *
 * ```ts
 * const report = verifyEncryptedColumns({
 *   registry: ENCRYPTED_COLUMNS,                          // @taizan/prisma-base
 *   schemaText: files.map((f) => readFileSync(f, 'utf8')), // prisma/schema/**\/*.prisma
 *   rotationCoverage: planRotation(ENCRYPTED_COLUMNS, 'k1', 'k2', { dryRun: true }).items.map(
 *     (i) => i.ref,
 *   ),
 * })
 * expect(report.missingInRegistry).toEqual([])
 * ```
 *
 * @param input - 三处的输入
 * @returns 三组差异；`ok` 为 true 表示三处完全对得上
 */
export function verifyEncryptedColumns(input: VerifyEncryptedColumnsInput): EncryptedColumnsReport {
  const overrides = input.keyIdOverrides ?? DEFAULT_KEY_ID_OVERRIDES
  const models = parsePrismaModels(input.schemaText)
  const byName = new Map(models.map((m) => [m.name, m]))

  // ---- schema 侧：扫出全部 `*Enc` 的 String 列 --------------------------------
  const schemaColumns: ColumnRef[] = []
  for (const model of models) {
    for (const field of model.fields) {
      if (!field.endsWith(ENCRYPTED_COLUMN_SUFFIX)) continue
      // 只认 String：Json/Bytes 列即便叫 `xxxEnc` 也不是本包的密文格式。
      if (model.types[field] !== 'String') continue
      schemaColumns.push(refOf(model.name, field))
    }
  }

  // ---- 注册表侧 --------------------------------------------------------------
  const registryColumns = input.registry.map((c) => refOf(c.model, c.column))
  const registrySet = new Set(registryColumns)
  const schemaSet = new Set(schemaColumns)

  // 第一组：注册表 ↔ schema 双向
  const missingInSchema = sortedUnique(registryColumns.filter((r) => !schemaSet.has(r)))
  const missingInRegistry = sortedUnique(schemaColumns.filter((r) => !registrySet.has(r)))

  // 第二组：每个 `*Enc` 列都要有配对 keyId 列。
  // 期望列名优先取注册表登记的 keyIdColumn（真源），没登记才用命名规则推。
  const registered = new Map(input.registry.map((c) => [refOf(c.model, c.column), c]))
  const missingKeyIdColumn: MissingKeyIdEntry[] = []
  for (const ref of schemaColumns) {
    const [modelName = '', column = ''] = ref.split('.')
    const model = byName.get(modelName)
    /* c8 ignore next -- ref 就是从 models 里生成的，取不到只可能是解析器坏了 */
    if (!model) continue
    const expected = registered.get(ref)?.keyIdColumn ?? keyIdColumnFor(column, overrides)
    if (!model.fields.includes(expected)) {
      missingKeyIdColumn.push({ ref, expected })
    }
  }
  // 注册表登记了、schema 里压根没这个模型的情况已由 missingInSchema 覆盖，这里不重复报。

  // 第三组：注册表 ↔ 轮换覆盖 双向
  const coverageSet = new Set(input.rotationCoverage)
  const missingInRotation = sortedUnique(registryColumns.filter((r) => !coverageSet.has(r)))
  const unknownInRotation = sortedUnique(
    [...input.rotationCoverage].filter((r) => !registrySet.has(r)),
  )

  return {
    ok:
      missingInSchema.length === 0 &&
      missingInRegistry.length === 0 &&
      missingKeyIdColumn.length === 0 &&
      missingInRotation.length === 0 &&
      unknownInRotation.length === 0,
    models,
    schemaColumns: sortedUnique(schemaColumns),
    registryColumns: sortedUnique(registryColumns),
    missingInSchema,
    missingInRegistry,
    missingKeyIdColumn,
    missingInRotation,
    unknownInRotation,
  }
}

/**
 * 把对账报告渲染成中文清单，给 spec 的失败信息与 CLI 输出用。
 *
 * @param report - {@link verifyEncryptedColumns} 的产物
 * @returns 每行一条问题；三处都对得上时返回单行「通过」
 */
export function formatEncryptedColumnsReport(report: EncryptedColumnsReport): string[] {
  if (report.ok) {
    return [
      `加密列三处对账通过：共 ${report.registryColumns.length} 列（注册表 = schema = 轮换覆盖）`,
    ]
  }
  const lines: string[] = []
  for (const ref of report.missingInSchema) {
    lines.push(`注册表登记了 ${ref}，但 schema 里没有这一列（改名后忘了同步注册表？）`)
  }
  for (const ref of report.missingInRegistry) {
    lines.push(`schema 里的 ${ref} 没有登记进加密列注册表，换密钥时这一列会被整列跳过`)
  }
  for (const entry of report.missingKeyIdColumn) {
    lines.push(`${entry.ref} 缺配对的密钥版本号列 ${entry.expected}，换完密钥这些行分不清新旧`)
  }
  for (const ref of report.missingInRotation) {
    lines.push(`${ref} 登记了但轮换没覆盖到，等于没登记`)
  }
  for (const ref of report.unknownInRotation) {
    lines.push(`轮换覆盖了 ${ref}，但它不在加密列注册表里（--only 的列名写错了？）`)
  }
  return lines
}
