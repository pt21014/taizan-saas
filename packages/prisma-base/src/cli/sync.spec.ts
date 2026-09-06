/**
 * `taizan-schema-sync` 的单测。
 *
 * 核心那条（蓝图 spec 15）是：**同步过去之后 `--check` 必须过，改一个字节必须红**。
 * 只测「能同步」不够——真正会出事的是「片段被手改了但 CI 没发现」。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { BASE_SCHEMA_FILES } from '../schema-files'
import { PRISMA_BASE_VERSION } from '../version'
import {
  buildBaseSchemaLock,
  checkSchemaSync,
  hashSchemaContent,
  normalizeEol,
  parseSchemaSyncArgs,
  readBaseSchemaFiles,
  runSchemaSyncCli,
  writeSchemaSync,
  type BaseSchemaLock,
} from './sync'

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SOURCE_DIR = join(PACKAGE_ROOT, 'schema')

const temps: string[] = []

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'taizan-schema-sync-'))
  temps.push(dir)
  return dir
}

function collect(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = []
  return { lines, write: (line) => void lines.push(line) }
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop() as string
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('hashSchemaContent / normalizeEol', () => {
  it('CRLF 与 LF 算出同一个 hash（不然 Windows 检出天天误报）', () => {
    expect(hashSchemaContent('a\r\nb\n')).toBe(hashSchemaContent('a\nb\n'))
    expect(normalizeEol('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('内容不同则 hash 不同', () => {
    expect(hashSchemaContent('a')).not.toBe(hashSchemaContent('b'))
  })
})

describe('readBaseSchemaFiles', () => {
  it('读齐 9 个片段', () => {
    const files = readBaseSchemaFiles(SOURCE_DIR)
    expect([...files.keys()]).toEqual([...BASE_SCHEMA_FILES])
  })

  it('少片段直接抛错（少同步一张表比不同步更难查）', () => {
    const dir = newTempDir()
    writeFileSync(join(dir, '00-datasource.prisma'), 'x', 'utf8')
    expect(() => readBaseSchemaFiles(dir)).toThrow(/缺少片段/)
  })
})

describe('buildBaseSchemaLock', () => {
  it('记下包名、版本、算法与每个文件的 sha256', () => {
    const files = readBaseSchemaFiles(SOURCE_DIR)
    const lock = buildBaseSchemaLock(files, new Date('2026-01-01T00:00:00.000Z'))
    expect(lock.package).toBe('@taizan/prisma-base')
    expect(lock.version).toBe(PRISMA_BASE_VERSION)
    expect(lock.algorithm).toBe('sha256')
    expect(lock.generatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(Object.keys(lock.files).sort()).toEqual([...BASE_SCHEMA_FILES].sort())
    for (const hash of Object.values(lock.files)) expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('writeSchemaSync + checkSchemaSync', () => {
  it('同步后目录里有 00-base/ 与 base.lock.json，且 --check 通过', () => {
    const target = newTempDir()
    const result = writeSchemaSync(target, SOURCE_DIR)
    expect(readdirSync(result.baseDir).sort()).toEqual([...BASE_SCHEMA_FILES].sort())
    expect(readdirSync(target)).toContain('base.lock.json')
    expect(checkSchemaSync(target, SOURCE_DIR).ok).toBe(true)
  })

  it('改一个字节后 --check 报 modified + lock-mismatch', () => {
    const target = newTempDir()
    const { baseDir } = writeSchemaSync(target, SOURCE_DIR)
    const victim = join(baseDir, '01-tenant.prisma')
    writeFileSync(victim, `${readFileSync(victim, 'utf8')} `, 'utf8')

    const result = checkSchemaSync(target, SOURCE_DIR)
    expect(result.ok).toBe(false)
    expect(result.diffs.map((d) => d.kind).sort()).toEqual(['lock-mismatch', 'modified'])
    expect(result.diffs[0]?.file).toBe('01-tenant.prisma')
  })

  it('删掉一个片段后 --check 报 missing', () => {
    const target = newTempDir()
    const { baseDir } = writeSchemaSync(target, SOURCE_DIR)
    rmSync(join(baseDir, '08-notify.prisma'))
    const result = checkSchemaSync(target, SOURCE_DIR)
    expect(result.ok).toBe(false)
    expect(result.diffs.some((d) => d.kind === 'missing' && d.file === '08-notify.prisma')).toBe(
      true,
    )
  })

  it('多出一个片段后 --check 报 extra，重跑 sync 会清掉它', () => {
    const target = newTempDir()
    const { baseDir } = writeSchemaSync(target, SOURCE_DIR)
    writeFileSync(join(baseDir, '99-legacy.prisma'), 'model Legacy { id String @id }\n', 'utf8')
    expect(checkSchemaSync(target, SOURCE_DIR).diffs.some((d) => d.kind === 'extra')).toBe(true)

    const again = writeSchemaSync(target, SOURCE_DIR)
    expect(again.removed).toEqual(['99-legacy.prisma'])
    expect(checkSchemaSync(target, SOURCE_DIR).ok).toBe(true)
  })

  it('lock 不存在 / 不是合法 JSON 时报 lock-missing', () => {
    const target = newTempDir()
    writeSchemaSync(target, SOURCE_DIR)
    rmSync(join(target, 'base.lock.json'))
    expect(checkSchemaSync(target, SOURCE_DIR).diffs.some((d) => d.kind === 'lock-missing')).toBe(
      true,
    )

    writeFileSync(join(target, 'base.lock.json'), '{ not json', 'utf8')
    expect(checkSchemaSync(target, SOURCE_DIR).diffs.some((d) => d.kind === 'lock-missing')).toBe(
      true,
    )

    writeFileSync(join(target, 'base.lock.json'), '"a string"', 'utf8')
    expect(checkSchemaSync(target, SOURCE_DIR).diffs.some((d) => d.kind === 'lock-missing')).toBe(
      true,
    )
  })

  it('lock 里的版本对不上时报 lock-stale（装了新版包但没重跑 sync）', () => {
    const target = newTempDir()
    writeSchemaSync(target, SOURCE_DIR)
    const lockPath = join(target, 'base.lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as BaseSchemaLock
    lock.version = '0.0.1'
    writeFileSync(lockPath, JSON.stringify(lock), 'utf8')
    const result = checkSchemaSync(target, SOURCE_DIR)
    expect(result.ok).toBe(false)
    expect(result.diffs.some((d) => d.kind === 'lock-stale')).toBe(true)
  })

  it('目标目录还不存在时 --check 全报 missing 而不是崩', () => {
    const target = join(newTempDir(), 'never-created')
    const result = checkSchemaSync(target, SOURCE_DIR)
    expect(result.ok).toBe(false)
    expect(result.diffs.filter((d) => d.kind === 'missing')).toHaveLength(BASE_SCHEMA_FILES.length)
  })

  it('同步是幂等的：连跑两次内容与 hash 都不变', () => {
    const target = newTempDir()
    writeSchemaSync(target, SOURCE_DIR)
    const before = readFileSync(join(target, '00-base', '02-plan.prisma'), 'utf8')
    writeSchemaSync(target, SOURCE_DIR)
    expect(readFileSync(join(target, '00-base', '02-plan.prisma'), 'utf8')).toBe(before)
  })
})

describe('parseSchemaSyncArgs', () => {
  it('解析目标目录、--check、--from', () => {
    const args = parseSchemaSyncArgs(['prisma/schema', '--check', '--from=/tmp/s'])
    expect(args).toMatchObject({ targetDir: 'prisma/schema', check: true, from: '/tmp/s' })
    expect(args.errors).toEqual([])
  })

  it('未知选项、重复目录、空 --from 都进 errors', () => {
    expect(parseSchemaSyncArgs(['--wat']).errors[0]).toContain('未知选项')
    expect(parseSchemaSyncArgs(['a', 'b']).errors[0]).toContain('只能给一个目标目录')
    expect(parseSchemaSyncArgs(['--from=  ']).errors[0]).toContain('--from')
  })

  it('-h / --help 被识别', () => {
    expect(parseSchemaSyncArgs(['-h']).help).toBe(true)
    expect(parseSchemaSyncArgs(['--help']).help).toBe(true)
  })
})

describe('runSchemaSyncCli', () => {
  it('--help 打帮助并退出 0', () => {
    const { lines, write } = collect()
    expect(runSchemaSyncCli(['--help'], write, SOURCE_DIR)).toBe(0)
    expect(lines.join('\n')).toContain('taizan-schema-sync')
  })

  it('参数不对退出 2', () => {
    const { lines, write } = collect()
    expect(runSchemaSyncCli(['--wat'], write, SOURCE_DIR)).toBe(2)
    expect(lines.join('\n')).toContain('未知选项')
  })

  it('不给目标目录退出 2', () => {
    const { lines, write } = collect()
    expect(runSchemaSyncCli([], write, SOURCE_DIR)).toBe(2)
    expect(lines.join('\n')).toContain('至少要给一个目标')
  })

  it('源目录不完整时退出 2 而不是写出半份 schema', () => {
    const broken = newTempDir()
    const { lines, write } = collect()
    expect(runSchemaSyncCli([newTempDir()], write, broken)).toBe(2)
    expect(lines.join('\n')).toContain('缺少片段')

    const { lines: l2, write: w2 } = collect()
    expect(runSchemaSyncCli([newTempDir(), '--check'], w2, broken)).toBe(2)
    expect(l2.join('\n')).toContain('缺少片段')
  })

  it('--from 指向的目录优先于 override', () => {
    const target = newTempDir()
    const { write } = collect()
    expect(runSchemaSyncCli([target, `--from=${SOURCE_DIR}`], write)).toBe(0)
    expect(checkSchemaSync(target, SOURCE_DIR).ok).toBe(true)
  })

  it('写入 → --check 退出 0；改一个字节 → --check 退出 1 并列出差异文件', () => {
    const target = newTempDir()
    const { lines, write } = collect()
    expect(runSchemaSyncCli([target], write, SOURCE_DIR)).toBe(0)
    expect(lines.join('\n')).toContain('已同步 9 个框架片段')

    const { lines: okLines, write: okWrite } = collect()
    expect(runSchemaSyncCli([target, '--check'], okWrite, SOURCE_DIR)).toBe(0)
    expect(okLines.join('\n')).toContain('一致')

    const victim = join(target, '00-base', '04-rbac.prisma')
    writeFileSync(victim, `${readFileSync(victim, 'utf8')}\n// 手改一行\n`, 'utf8')

    const { lines: badLines, write: badWrite } = collect()
    expect(runSchemaSyncCli([target, '--check'], badWrite, SOURCE_DIR)).toBe(1)
    const report = badLines.join('\n')
    expect(report).toContain('04-rbac.prisma')
    expect(report).toContain('[modified]')
    expect(report).toContain('不接受手改')
  })

  it('清掉旧片段时在输出里说明', () => {
    const target = newTempDir()
    mkdirSync(join(target, '00-base'), { recursive: true })
    writeFileSync(join(target, '00-base', '77-old.prisma'), 'x', 'utf8')
    const { lines, write } = collect()
    expect(runSchemaSyncCli([target], write, SOURCE_DIR)).toBe(0)
    expect(lines.join('\n')).toContain('77-old.prisma')
  })
})
