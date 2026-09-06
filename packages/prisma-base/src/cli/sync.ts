#!/usr/bin/env node
/**
 * `taizan-schema-sync`：把框架 schema 片段同步进业务项目，并写 `base.lock.json`。
 *
 * ```bash
 * taizan-schema-sync apps/api/prisma/schema          # 写入（升级框架后跑）
 * taizan-schema-sync apps/api/prisma/schema --check  # 只比对（CI 与 spec 15 跑）
 * ```
 *
 * 为什么是「同步 + 校验」而不是「引用」：Prisma 不能从 `node_modules` include 片段，
 * 所以框架片段必须真的落到项目仓库里。落进去就会被人手改，于是必须有 lock 来发现手改
 * ——`--check` 不一致时非零退出，蓝图 spec 15 就靠它。
 *
 * 只用 node 内置模块（fs/path/crypto）+ 本包自己的常量，零 npm 依赖。
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'

import {
  BASE_LOCK_FILE_NAME,
  BASE_SCHEMA_DIR_NAME,
  BASE_SCHEMA_FILES,
  resolveBaseSchemaDir,
} from '../schema-files'
import { PRISMA_BASE_PACKAGE_NAME, PRISMA_BASE_VERSION } from '../version'

/** `base.lock.json` 的结构。业务项目的 spec 15 直接读它。 */
export interface BaseSchemaLock {
  /** 写这份 lock 的包名。 */
  package: string
  /** 写这份 lock 时的包版本。升级框架必然改这里，是「该重跑 sync 了」的信号。 */
  version: string
  /** 摘要算法，写死 sha256，留字段是为了将来换算法时能识别旧 lock。 */
  algorithm: 'sha256'
  /** 生成时间（ISO 8601）。只作排查用，不参与比对。 */
  generatedAt: string
  /** 文件名 → sha256（十六进制小写）。 */
  files: Record<string, string>
}

/** 一处差异。 */
export interface SchemaSyncDiff {
  /** 出问题的文件名（lock 自身的问题用 `base.lock.json`）。 */
  file: string
  /** 差异类型。 */
  kind: 'missing' | 'modified' | 'extra' | 'lock-missing' | 'lock-stale' | 'lock-mismatch'
  /** 中文说明。 */
  detail: string
}

/** {@link checkSchemaSync} 的结果。 */
export interface SchemaSyncCheckResult {
  /** 是否完全一致。 */
  ok: boolean
  /** 目标目录 `<targetDir>/00-base`。 */
  baseDir: string
  /** lock 文件绝对路径。 */
  lockPath: string
  /** 全部差异，按文件名排序。 */
  diffs: SchemaSyncDiff[]
}

/** 把 CRLF / CR 统一成 LF。 */
export function normalizeEol(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

/**
 * 计算一段文本的 sha256。
 *
 * **先把 CRLF 归一成 LF 再算**：Windows 检出会把换行改掉，不归一的话同一份内容在两台机器上
 * 算出两个 hash，lock 天天误报。写文件时同样只写 LF。
 *
 * @param content - 文件内容
 * @returns 十六进制小写摘要
 */
export function hashSchemaContent(content: string): string {
  return createHash('sha256').update(normalizeEol(content), 'utf8').digest('hex')
}

/**
 * 读出框架的全部 schema 片段。
 *
 * @param sourceDir - 框架 `schema/` 目录
 * @returns 文件名 → 内容（已归一换行），顺序同 {@link BASE_SCHEMA_FILES}
 * @throws {@link Error} 少了任何一个片段时（少片段 = 同步出去的 schema 不完整）
 */
export function readBaseSchemaFiles(sourceDir: string): Map<string, string> {
  const files = new Map<string, string>()
  const missing: string[] = []
  for (const name of BASE_SCHEMA_FILES) {
    const path = join(sourceDir, name)
    if (!existsSync(path)) {
      missing.push(name)
      continue
    }
    files.set(name, normalizeEol(readFileSync(path, 'utf8')))
  }
  if (missing.length > 0) {
    throw new Error(`框架 schema 目录 ${sourceDir} 缺少片段：${missing.join(', ')}`)
  }
  return files
}

/**
 * 生成 lock 内容。
 *
 * @param files - {@link readBaseSchemaFiles} 的结果
 * @param now - 生成时间，默认当前时刻（测试里传固定值）
 * @returns lock 对象
 */
export function buildBaseSchemaLock(
  files: ReadonlyMap<string, string>,
  now: Date = new Date(),
): BaseSchemaLock {
  const hashed: Record<string, string> = {}
  for (const name of [...files.keys()].sort()) {
    hashed[name] = hashSchemaContent(files.get(name) ?? '')
  }
  return {
    package: PRISMA_BASE_PACKAGE_NAME,
    version: PRISMA_BASE_VERSION,
    algorithm: 'sha256',
    generatedAt: now.toISOString(),
    files: hashed,
  }
}

function readLock(lockPath: string): BaseSchemaLock | undefined {
  if (!existsSync(lockPath)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as Partial<BaseSchemaLock>
    if (typeof candidate.version !== 'string' || typeof candidate.files !== 'object') {
      return undefined
    }
    return candidate as BaseSchemaLock
  } catch {
    return undefined
  }
}

/** 列出目标 `00-base/` 里现有的 `.prisma` 文件名。 */
function listTargetFragments(baseDir: string): string[] {
  if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) return []
  return readdirSync(baseDir)
    .filter((name) => name.endsWith('.prisma'))
    .sort()
}

/**
 * 比对目标目录与框架片段（`--check` 的实现）。
 *
 * 比三件事，任一不过就是不一致：
 * 1. 目标 `00-base/` 的每个片段内容与框架片段逐字节一致（多、少、改都算）；
 * 2. lock 存在、版本与当前包版本一致（版本对不上说明「装了新版包但没重跑 sync」）；
 * 3. lock 里记的 hash 与目标目录里的实际文件一致（手改文件 + 忘改 lock 会在这里被抓）。
 *
 * @param targetDir - 业务项目的 `prisma/schema` 目录
 * @param sourceDir - 框架 `schema/` 目录
 * @returns 比对结果，见 {@link SchemaSyncCheckResult}
 */
export function checkSchemaSync(targetDir: string, sourceDir: string): SchemaSyncCheckResult {
  const absTarget = resolve(targetDir)
  const baseDir = join(absTarget, BASE_SCHEMA_DIR_NAME)
  const lockPath = join(absTarget, BASE_LOCK_FILE_NAME)
  const source = readBaseSchemaFiles(sourceDir)
  const diffs: SchemaSyncDiff[] = []

  for (const [name, content] of source) {
    const path = join(baseDir, name)
    if (!existsSync(path)) {
      diffs.push({ file: name, kind: 'missing', detail: `目标目录里没有这个框架片段：${path}` })
      continue
    }
    if (normalizeEol(readFileSync(path, 'utf8')) !== content) {
      diffs.push({
        file: name,
        kind: 'modified',
        detail: '内容与框架片段不一致：要么被手改了，要么框架升级后没重跑 sync。',
      })
    }
  }

  for (const name of listTargetFragments(baseDir)) {
    if (!source.has(name)) {
      diffs.push({
        file: name,
        kind: 'extra',
        detail: '框架已经没有这个片段了（多半是升级后删掉的表），重跑 sync 会清掉它。',
      })
    }
  }

  const lock = readLock(lockPath)
  if (lock === undefined) {
    diffs.push({
      file: BASE_LOCK_FILE_NAME,
      kind: 'lock-missing',
      detail: `${lockPath} 不存在或不是合法 lock，无法判断片段来自哪个框架版本。`,
    })
  } else {
    if (lock.version !== PRISMA_BASE_VERSION) {
      diffs.push({
        file: BASE_LOCK_FILE_NAME,
        kind: 'lock-stale',
        detail: `lock 记的是 ${lock.version}，当前 ${PRISMA_BASE_PACKAGE_NAME} 是 ${PRISMA_BASE_VERSION}。`,
      })
    }
    for (const name of [...source.keys()].sort()) {
      const path = join(baseDir, name)
      if (!existsSync(path)) continue
      const actual = hashSchemaContent(readFileSync(path, 'utf8'))
      const recorded = lock.files[name]
      if (recorded !== actual) {
        diffs.push({
          file: name,
          kind: 'lock-mismatch',
          detail: `lock 记的 sha256 是 ${recorded ?? '（没记）'}，实际是 ${actual}。`,
        })
      }
    }
  }

  diffs.sort((a, b) =>
    a.file === b.file ? a.kind.localeCompare(b.kind) : a.file.localeCompare(b.file),
  )
  return { ok: diffs.length === 0, baseDir, lockPath, diffs }
}

/** {@link writeSchemaSync} 的结果。 */
export interface SchemaSyncWriteResult {
  /** 目标 `00-base/` 目录。 */
  baseDir: string
  /** lock 文件绝对路径。 */
  lockPath: string
  /** 实际写出的片段文件名。 */
  written: string[]
  /** 被清掉的、框架已不再提供的旧片段。 */
  removed: string[]
}

/**
 * 把框架片段写进目标目录并生成 lock。
 *
 * 会**删掉** `00-base/` 里框架已不再提供的 `.prisma`：留着旧片段会让 Prisma 继续拼进
 * 已删除的表，比少同步还难查。业务自己的片段请放在 `10-business/`，不要放进 `00-base/`。
 *
 * @param targetDir - 业务项目的 `prisma/schema` 目录
 * @param sourceDir - 框架 `schema/` 目录
 * @param now - 写进 lock 的时间戳，默认当前时刻
 * @returns 写入结果，见 {@link SchemaSyncWriteResult}
 */
export function writeSchemaSync(
  targetDir: string,
  sourceDir: string,
  now: Date = new Date(),
): SchemaSyncWriteResult {
  const absTarget = resolve(targetDir)
  const baseDir = join(absTarget, BASE_SCHEMA_DIR_NAME)
  const lockPath = join(absTarget, BASE_LOCK_FILE_NAME)
  const source = readBaseSchemaFiles(sourceDir)

  mkdirSync(baseDir, { recursive: true })

  const removed: string[] = []
  for (const name of listTargetFragments(baseDir)) {
    if (!source.has(name)) {
      rmSync(join(baseDir, name))
      removed.push(name)
    }
  }

  const written: string[] = []
  for (const [name, content] of source) {
    writeFileSync(join(baseDir, name), content, 'utf8')
    written.push(name)
  }

  writeFileSync(lockPath, `${JSON.stringify(buildBaseSchemaLock(source, now), null, 2)}\n`, 'utf8')
  return { baseDir, lockPath, written, removed }
}

/** 命令行参数解析结果。 */
export interface SchemaSyncCliArgs {
  /** 目标 `prisma/schema` 目录。 */
  targetDir?: string
  /** 框架片段目录（`--from=`），不给则自动定位本包的 `schema/`。 */
  from?: string
  /** `--check`：只比对不写。 */
  check: boolean
  /** `--help`。 */
  help: boolean
  /** 中文错误清单。 */
  errors: string[]
}

const USAGE = [
  '用法：taizan-schema-sync <prisma/schema 目录> [选项]',
  '',
  '把 @taizan/prisma-base 的框架片段同步到 <目录>/00-base/，并写 <目录>/base.lock.json。',
  '',
  '选项：',
  '  --check        只比对不写；有任何差异以退出码 1 结束并列出差异文件',
  '  --from=<dir>   框架片段所在目录（默认自动定位已安装的 @taizan/prisma-base/schema）',
  '  --help         打印本帮助',
].join('\n')

/**
 * 解析命令行参数（纯函数，方便单测）。
 *
 * @param argv - `process.argv.slice(2)`
 * @returns 解析结果，见 {@link SchemaSyncCliArgs}
 */
export function parseSchemaSyncArgs(argv: readonly string[]): SchemaSyncCliArgs {
  const result: SchemaSyncCliArgs = { check: false, help: false, errors: [] }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      result.help = true
      continue
    }
    if (arg === '--check') {
      result.check = true
      continue
    }
    if (arg.startsWith('--from=')) {
      const value = arg.slice('--from='.length).trim()
      if (value === '') result.errors.push('--from 后面要给目录路径。')
      else result.from = value
      continue
    }
    if (arg.startsWith('-')) {
      result.errors.push(`未知选项 ${arg}`)
      continue
    }
    if (result.targetDir !== undefined) {
      result.errors.push(`只能给一个目标目录（已经收到 ${result.targetDir}，又收到 ${arg}）。`)
      continue
    }
    result.targetDir = arg
  }
  return result
}

/** 当前 CLI 脚本所在目录。ESM/CJS 双产物都能拿到的只有 `process.argv[1]`。 */
function currentScriptDir(): string {
  const entry = process.argv[1]
  return typeof entry === 'string' && entry !== '' ? dirname(resolve(entry)) : process.cwd()
}

/**
 * 跑一次 CLI。不直接碰 `process` 的输出，输出经 `write` 回调，方便单测断言。
 *
 * @param argv - `process.argv.slice(2)`
 * @param write - 输出一行的回调
 * @param sourceDirOverride - 框架片段目录，测试里直接给；命令行用 `--from=` 或自动定位
 * @returns 退出码：0 通过，1 不一致，2 参数或环境问题
 */
export function runSchemaSyncCli(
  argv: readonly string[],
  write: (line: string) => void = (line) => {
    // CLI 的唯一职责就是把中文清单打到标准输出。
    console.log(line)
  },
  sourceDirOverride?: string,
): number {
  const args = parseSchemaSyncArgs(argv)

  if (args.help) {
    write(USAGE)
    return 0
  }
  if (args.errors.length > 0) {
    for (const error of args.errors) write(`✗ ${error}`)
    write('')
    write(USAGE)
    return 2
  }
  if (args.targetDir === undefined) {
    write('✗ 至少要给一个目标 prisma/schema 目录。')
    write('')
    write(USAGE)
    return 2
  }

  let sourceDir: string
  try {
    sourceDir = args.from ?? sourceDirOverride ?? resolveBaseSchemaDir(currentScriptDir())
  } catch (error) {
    write(`✗ ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  if (args.check) {
    let result: SchemaSyncCheckResult
    try {
      result = checkSchemaSync(args.targetDir, sourceDir)
    } catch (error) {
      write(`✗ ${error instanceof Error ? error.message : String(error)}`)
      return 2
    }
    if (result.ok) {
      write(
        `✓ ${result.baseDir} 与 ${PRISMA_BASE_PACKAGE_NAME}@${PRISMA_BASE_VERSION} 的框架片段一致。`,
      )
      return 0
    }
    write(
      `✗ 框架片段与 ${PRISMA_BASE_PACKAGE_NAME}@${PRISMA_BASE_VERSION} 不一致，共 ${result.diffs.length} 处：`,
    )
    for (const diff of result.diffs) write(`  - [${diff.kind}] ${diff.file}：${diff.detail}`)
    write('')
    write('处理：确认 diff 是框架升级带来的之后重跑 `pnpm taizan:schema-sync`；')
    write('框架片段不接受手改，业务自己的表请放到 10-business/ 下。')
    return 1
  }

  let result: SchemaSyncWriteResult
  try {
    result = writeSchemaSync(args.targetDir, sourceDir)
  } catch (error) {
    write(`✗ ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  write(`✓ 已同步 ${result.written.length} 个框架片段到 ${result.baseDir}`)
  for (const name of result.removed) write(`  - 清掉了框架已不再提供的片段：${name}`)
  write(`✓ 已写 ${result.lockPath}（${PRISMA_BASE_PACKAGE_NAME}@${PRISMA_BASE_VERSION}）`)
  return 0
}

/** 被 `node .../sync.js` 直接调用时才执行；被 import（单测）时不执行。 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && /^sync(\.[cm]?js)?$/.test(basename(entry))
}

/* c8 ignore start -- 只有真的用 node 跑这个文件时才走到，单测走 runSchemaSyncCli */
if (isDirectInvocation()) {
  process.exitCode = runSchemaSyncCli(process.argv.slice(2))
}
/* c8 ignore stop */
