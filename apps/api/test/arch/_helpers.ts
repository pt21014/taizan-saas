/**
 * 架构 spec 共用的小工具：定位目录、读源码、剥注释。
 *
 * 不是 `.spec.ts`，vitest 不会把它当测试跑。
 *
 * @packageDocumentation
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `apps/api/` 的绝对路径。 */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** `apps/api/src`。 */
export const SRC_DIR = join(APP_ROOT, 'src')

/** `apps/api/prisma/schema`。 */
export const SCHEMA_DIR = join(APP_ROOT, 'prisma', 'schema')

/**
 * 定位已安装的 `@taizan/prisma-base` 的 `schema/` 目录。
 *
 * 走 `require.resolve('@taizan/prisma-base/package.json')` 而不是拼相对路径
 * （`../../../../packages/prisma-base/schema`）：相对路径在生成器产出的项目里必然是错的
 * ——那时候框架是从 npm 装的，根本没有 `packages/` 目录。这份 spec 要能原样被生成器带走。
 */
export function frameworkSchemaDir(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@taizan/prisma-base/package.json')), 'schema')
}

/** 一份源码。 */
export interface SourceFile {
  /** 相对 `apps/api/` 的 POSIX 路径，例如 `src/modules/admin/auth/admin-auth.service.ts`。 */
  path: string
  /** 绝对路径。 */
  absolute: string
  source: string
}

/**
 * 递归读一个目录下的所有 `.ts`（不含 `.spec.ts` 与 `.d.ts`）。
 *
 * @param dir - 起始目录（绝对路径）
 * @param filter - 额外的文件名过滤
 */
export function readSources(
  dir: string,
  filter: (path: string) => boolean = () => true,
): SourceFile[] {
  const out: SourceFile[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry)
      if (statSync(absolute).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue
        walk(absolute)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      if (entry.endsWith('.d.ts') || entry.endsWith('.spec.ts')) continue
      const path = relative(APP_ROOT, absolute).split(sep).join(posix.sep)
      if (!filter(path)) continue
      out.push({ path, absolute, source: readFileSync(absolute, 'utf8') })
    }
  }
  walk(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 把注释与字符串字面量**替换成等长空白**（保持偏移量不变）。
 *
 * 为什么要替换而不是删掉：这些 spec 会报「第几行」，删掉之后行号就对不上了，
 * 而一条指不出位置的架构断言等于让人自己去全仓找。
 *
 * 为什么连字符串一起剥：注释里写 `// 不要写 where: { tenantId }` 会被扫成违规，
 * 而文档恰恰应该能自由地举反例。
 */
export function blankCommentsAndStrings(source: string): string {
  const out = source.split('')
  let i = 0
  const n = source.length
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }
  while (i < n) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const end = source.indexOf('\n', i)
      blank(i, end === -1 ? n : end)
      i = end === -1 ? n : end
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      blank(i, end === -1 ? n : end + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === ch) break
        j += 1
      }
      blank(i + 1, j)
      i = j + 1
      continue
    }
    i += 1
  }
  return out.join('')
}

/** 偏移量 → 1 起的行号。 */
export function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

/**
 * 从 `open` 位置（必须是 `{`）开始取一个**配平**的花括号块，返回 `[start, end)`。
 *
 * @returns 块的结束位置（`}` 之后）；不配平时返回源码长度
 */
export function balancedBlock(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return source.length
}

/** 一份 `.prisma` 片段。 */
export interface SchemaFile {
  /** 相对 `prisma/schema/` 的 POSIX 路径，例如 `10-business/10-goods.prisma`。 */
  name: string
  /** 绝对路径。 */
  absolute: string
  source: string
}

/**
 * 递归读 `prisma/schema/**\/*.prisma`（`index.spec.ts` 的 spec 9 / 10 / 11 用）。
 *
 * 为什么不复用各 spec 自己的读法：spec 1 走 `verifySchema({ schemaDirs })`、
 * spec 15 走 `checkSchemaSync`，两者都只要目录不要内容。而 schema 约定类的断言
 * （金额列、枚举、加密列）需要**拼起来的全文**——`lintSchemaConventions` 与
 * `verifyEncryptedColumns` 都是纯函数，不碰 fs，得由调用方把文本喂进去。
 *
 * 返回值按 `name` 排序，让失败信息里的顺序稳定（否则不同机器上的 readdir 顺序不同，
 * 两次 CI 的报错行会对不上，看起来像是「又坏了别的东西」）。
 */
export function readSchemaFiles(dir: string = SCHEMA_DIR): SchemaFile[] {
  const out: SchemaFile[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry)
      if (statSync(absolute).isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.endsWith('.prisma')) continue
      out.push({
        name: relative(dir, absolute).split(sep).join(posix.sep),
        absolute,
        source: readFileSync(absolute, 'utf8'),
      })
    }
  }
  walk(dir)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
