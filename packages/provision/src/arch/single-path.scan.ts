/**
 * spec 14（`provision-single-path.spec.ts`）的扫描器（蓝图 §8 第 14 条）。
 *
 * ## 它守的是什么
 *
 * 「建租户的事务只允许出现在 `@taizan/provision` 的调用点；控制器里不许再拼一遍。」
 *
 * **双向**对账：
 *
 * 1. 源码里每一处 `tenant.create(` / `tenant.upsert(` / `tenant.createMany(` 都必须落在
 *    白名单里。漏掉的后果不是报错，是那条路建出来的租户**少几张初始化的表**——
 *    而下游所有代码都默认它和别人一样。
 * 2. 白名单里的每一项都必须真的还有调用点。**陈旧的白名单比没有白名单更糟**：
 *    它让人以为那处豁免还有人在看，而实际上那个文件可能早就被重写成了第二条建店路径。
 *
 * ## 为什么是正则而不是 TS AST
 *
 * 与 `@taizan/nest-rbac` 的 `require-permission.scan.ts`、`@taizan/nest-auth` 的
 * `default-deny.scan.ts` 同一个取舍：调用形状固定，正则够用；引 `typescript` 的 compiler API
 * 会给一个架构测试加上几十兆依赖并显著变慢。
 *
 * 代价是极端写法会漏（`tx['tenant'].create()`、`const t = tx.tenant; t.create()`），
 * 所以带一个**哨兵**（{@link SENTINEL_SOURCE}）：正则一旦被改坏，哨兵先炸，
 * 而不是让真实代码「一条都没扫到」地假通过——「扫不到」和「没问题」在断言上长得一模一样，
 * 这是静态扫描最容易骗过自己的地方。
 *
 * ## 给 apps/api 用
 *
 * ```ts
 * // apps/api/test/arch/provision-single-path.spec.ts
 * import { scanTenantCreateCalls, SENTINEL_SOURCE, SENTINEL_EXPECTATION } from '@taizan/provision/arch'
 *
 * it('建租户只有一条路', () => {
 *   const report = scanTenantCreateCalls('src', [
 *     // 唯一豁免：这里就是那条路的调用点本身
 *     'src/modules/platform/tenant/platform-tenant.service.ts',
 *   ])
 *   expect(report.violations).toEqual([])
 * })
 * ```
 *
 * @packageDocumentation
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

/** 一份源码。 */
export interface SourceFile {
  path: string
  source: string
}

/**
 * 扫描输入：一个 glob 字符串、若干 glob 字符串，或已经读好的源码列表。
 *
 * glob 只支持最常用的一种形状：`<目录>/**\/*.<扩展名>`（`**` 与 `*` 各出现一次）；
 * 不含 `*` 时当作目录，递归读 `.ts`。复杂 glob 请自己读文件后传 {@link SourceFile}[]——
 * 把一个 glob 引擎搬进架构测试换不来任何东西。
 */
export type ScanInput = string | readonly string[] | readonly SourceFile[]

/** 建租户调用的形态。 */
export type TenantWriteKind = 'create' | 'createMany' | 'upsert'

/** 一处建租户的调用点。 */
export interface TenantCreateCall {
  /** 源文件路径（正斜杠）。 */
  file: string
  /** 1 起算的行号。 */
  line: number
  /** 调用形态。 */
  kind: TenantWriteKind
  /** 该行原文（trim 后），进断言失败信息用。 */
  text: string
}

/**
 * 默认白名单：本包自己。
 *
 * `packages/provision/src/provision.ts` 是那条路本身；`dist` 与 `node_modules` 里的副本
 * 是同一份代码的构建产物（{@link readSourceFiles} 已经跳过它们，这里再兜一层）。
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  'packages/provision/src/provision.ts',
  'node_modules/@taizan/provision/',
]

/**
 * 剥掉行注释、块注释（含 TSDoc）与字符串/模板字面量的**内容**，只留下真代码。
 *
 * 没有这一步的话，注释里写的示例代码（`// 之前是 tx.tenant.create(...)`）、
 * TSDoc 里的用法示范、字符串里出现的样例文本（`"违规写法是 tenant.create("`）
 * 都会被正则误判成真调用——而这些恰恰是最常见的写法：解释「不要这么写」的注释，
 * 本身就包含被禁止的那段文本。
 *
 * 被剥掉的字符**逐个替换成空格**、换行符原样保留：这样剥完之后每一行的行号
 * 与列位置都不变，{@link TenantCreateCall.line} 依然精确指向真代码所在的那一行，
 * 调用方也还能按原始文本回去核对。
 *
 * 是一个简单的按字符扫描的状态机（行注释 / 块注释 / 引号字符串 / 模板字符串），
 * 不处理模板字符串里 `${}` 内嵌表达式的语法边界（连同 `${}` 一起当字符串内容剥掉）——
 * 这在「建租户」调用点上不是一个会真实出现的写法，为了这一种边界情况去写一个
 * 完整的模板字面量解析器不值得。
 */
export function stripCommentsAndStrings(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const two = i + 1 < n ? source.slice(i, i + 2) : ''
    const ch = source[i] as string

    if (two === '//') {
      let j = i
      while (j < n && source[j] !== '\n') j += 1
      out += ' '.repeat(j - i)
      i = j
      continue
    }

    if (two === '/*') {
      const close = source.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      out += blankKeepingNewlines(source.slice(i, end))
      i = end
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === quote) {
          j += 1
          break
        }
        j += 1
      }
      out += blankKeepingNewlines(source.slice(i, j))
      i = j
      continue
    }

    out += ch
    i += 1
  }
  return out
}

/** 把一段文本里除换行符之外的字符全部换成空格——保留行数与列宽，只清掉内容。 */
function blankKeepingNewlines(text: string): string {
  let result = ''
  for (const c of text) result += c === '\n' ? '\n' : ' '
  return result
}

/**
 * `tenant.create(` / `.tenant.createMany(` / `.tenant.upsert(`。
 *
 * 前面那个 `(?:^|[^\w$.])` 让 `tx.tenant.create(`、`prisma.raw.client.tenant.create(`
 * 都能命中，同时**不**把 `subTenant.create(` 这种别的模型误伤成违规
 * （`[^\w$.]` 里排掉了 `.` 之外的标识符字符；`.` 本身允许，因为它正是 `tx.` 的那个点）。
 */
const CALL_PATTERN = /(?:^|[^\w$])tenant\.(create|createMany|upsert)\s*\(/g

/** `upsert` 也算：它建得出租户，只是顺手带了「已存在就改」。seed 的演示租户就是这么建的。 */
function detect(line: string): TenantWriteKind[] {
  const kinds: TenantWriteKind[] = []
  CALL_PATTERN.lastIndex = 0
  let match = CALL_PATTERN.exec(line)
  while (match !== null) {
    kinds.push(match[1] as TenantWriteKind)
    match = CALL_PATTERN.exec(line)
  }
  return kinds
}

function isSourceFileList(input: ScanInput): input is readonly SourceFile[] {
  return Array.isArray(input) && input.length > 0 && typeof input[0] === 'object'
}

/**
 * 按 `<目录>/**\/*.<扩展名>` 读一批源码。
 *
 * @param pattern - glob；不含 `*` 时当作目录，递归读 `.ts`
 */
export function readSourceFiles(pattern: string): SourceFile[] {
  const starIndex = pattern.indexOf('*')
  const root = starIndex === -1 ? pattern : pattern.slice(0, starIndex).replace(/[\\/]$/, '')
  const dotIndex = pattern.lastIndexOf('.')
  const ext = starIndex === -1 || dotIndex < starIndex ? '.ts' : pattern.slice(dotIndex)

  const out: SourceFile[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (full.endsWith(ext)) {
        out.push({ path: full.split(sep).join('/'), source: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(root)
  return out
}

function toSourceFiles(input: ScanInput): SourceFile[] {
  if (typeof input === 'string') return readSourceFiles(input)
  if (isSourceFileList(input)) return [...input]
  return (input as readonly string[]).flatMap((pattern) => readSourceFiles(pattern))
}

/**
 * 白名单按**路径后缀**双向匹配：`src/x.ts` 与 `apps/api/src/x.ts` 互相认得。
 *
 * 反方向（白名单条目以文件路径结尾）不是多余的：扫描时的 cwd 决定了扫出来的路径长什么样，
 * 在包目录里扫得到 `src/provision.ts`，在仓库根扫得到 `packages/provision/src/provision.ts`，
 * 而白名单只能写死一种。只认一个方向的话，换个 cwd 跑同一份断言就会红。
 */
function matches(file: string, entry: string): boolean {
  const normalized = entry.split(sep).join('/')
  if (file === normalized) return true
  if (file.endsWith(`/${normalized}`)) return true
  if (normalized.endsWith(`/${file}`)) return true
  return file.includes(normalized)
}

/** 一条违规。 */
export interface SinglePathViolation {
  rule: 'unallowed-tenant-write' | 'stale-allowlist'
  /** `unallowed-tenant-write` 才有。 */
  at?: string
  /** `stale-allowlist` 才有。 */
  entry?: string
  /** 给人看的中文说明（直接进断言失败信息）。 */
  message: string
}

/** 扫描结果。 */
export interface SinglePathReport {
  /** 扫到的全部调用点（含白名单内的）。 */
  calls: TenantCreateCall[]
  /** 白名单外的调用点。 */
  violations: SinglePathViolation[]
  /** 扫了几个文件。**断言它大于 0**：扫了 0 个文件时下面全是空的，看起来像通过。 */
  scannedFiles: number
}

/**
 * 扫出源码里全部建租户的调用点，并与白名单双向对账。
 *
 * @param input - glob、glob 列表，或已经读好的源码（{@link ScanInput}）
 * @param allowlist - 允许出现调用点的文件（路径后缀匹配）。每一条都该在调用处写清楚理由——
 *   白名单没有理由就等于没有白名单。默认已含 {@link DEFAULT_ALLOWLIST}
 */
export function scanTenantCreateCalls(
  input: ScanInput,
  allowlist: readonly string[] = [],
): SinglePathReport {
  const files = toSourceFiles(input)
  const entries = [...DEFAULT_ALLOWLIST, ...allowlist]
  const hit = new Set<string>()
  const calls: TenantCreateCall[] = []
  const violations: SinglePathViolation[] = []

  for (const file of files) {
    // 只在剥掉注释/字符串之后的文本上跑正则；行号与列宽被 stripCommentsAndStrings
    // 刻意保持不变，所以两份数组逐行一一对应。
    const scanLines = stripCommentsAndStrings(file.source).split(/\r?\n/)
    const originalLines = file.source.split(/\r?\n/)
    for (let i = 0; i < scanLines.length; i += 1) {
      const line = scanLines[i] as string
      for (const kind of detect(line)) {
        const call: TenantCreateCall = {
          file: file.path,
          line: i + 1,
          kind,
          // 报给人看的原文用剥之前的那一行——剥过的行只是空格，没法核对。
          text: (originalLines[i] as string).trim(),
        }
        calls.push(call)

        const matched = entries.filter((entry) => matches(file.path, entry))
        if (matched.length === 0) {
          violations.push({
            rule: 'unallowed-tenant-write',
            at: `${call.file}:${String(call.line)}`,
            message:
              `${call.file}:${String(call.line)} 里出现了 tenant.${kind}(——建租户只有一条路，` +
              `请改成 provisionTenant(tx, …)（@taizan/provision）。` +
              `再拼一遍的下场是这条路建出来的租户少几张初始化的表，而下游全都默认它和别人一样。`,
          })
        }
        for (const entry of matched) hit.add(entry)
      }
    }
  }

  for (const entry of allowlist) {
    if (hit.has(entry)) continue
    violations.push({
      rule: 'stale-allowlist',
      entry,
      message:
        `白名单里的 "${entry}" 已经没有任何 tenant.create/upsert 调用点了，请删掉这一条。` +
        `留着的话，下一个人会以为那处豁免还有人在看。`,
    })
  }

  return { calls, violations, scannedFiles: files.length }
}

/**
 * 哨兵源码：一份**故意造出来**的、必须被扫出确定结果的输入。
 *
 * 照抄进 spec：断言
 * `scanTenantCreateCalls([{ path: 'sentinel.ts', source: SENTINEL_SOURCE }], ['sentinel.ts'])`
 * 得到 {@link SENTINEL_EXPECTATION} 描述的那些数字。正则被改坏时哨兵先炸。
 */
export const SENTINEL_SOURCE = `
async function sentinel(tx, prisma) {
  await tx.tenant.create({ data: {} })
  await prisma.raw.client.tenant.upsert({ where: {}, create: {}, update: {} })
  await tx.tenant.createMany({ data: [] })
  // 别的模型不算（subtenant 全小写，专门用来试 [^\\w$] 那道边界）：
  await tx.subtenant.create({ data: {} })
  await tx.staffAccount.create({ data: {} })
  // 读不算：
  await tx.tenant.findUnique({ where: { slug: 'x' } })
}
`

/** {@link SENTINEL_SOURCE} 必须被扫成这样。 */
export const SENTINEL_EXPECTATION = {
  /** 三个调用点。 */
  calls: 3,
  /** 依出现顺序的形态。 */
  kinds: ['create', 'upsert', 'createMany'] as const,
} as const
