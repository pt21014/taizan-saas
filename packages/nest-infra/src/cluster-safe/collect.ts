/**
 * 递归收集源码文件，喂给 {@link scanClusterSafety}。
 *
 * 放在 `@taizan/nest-infra/testing` 子入口而不是主入口：它要 `node:fs`，
 * 而主入口是要被 Nest 应用运行时加载的，没必要把文件系统访问带进去。
 *
 * @packageDocumentation
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceFile } from './scan'

/** {@link collectSourceFiles} 的选项。 */
export interface CollectOptions {
  /** 只收这些扩展名，默认 `['.ts', '.tsx']`。 */
  extensions?: readonly string[]
  /** 目录名黑名单，默认 `node_modules` / `dist` / `coverage` / `.turbo` / `.git`。 */
  skipDirs?: readonly string[]
  /** 路径包含这些片段的文件不收，默认排除测试文件（`.spec.` / `.test.`）。 */
  skipPathParts?: readonly string[]
}

const DEFAULT_SKIP_DIRS: readonly string[] = ['node_modules', 'dist', 'coverage', '.turbo', '.git']
const DEFAULT_SKIP_PARTS: readonly string[] = ['.spec.', '.test.']

/**
 * 递归读取一个目录下的源码。
 *
 * @param root - 目录绝对路径
 * @returns `{ path, content }` 列表，`path` 是相对 `root` 的 POSIX 风格路径
 */
export function collectSourceFiles(root: string, options: CollectOptions = {}): SourceFile[] {
  const extensions = options.extensions ?? ['.ts', '.tsx']
  const skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS)
  const skipParts = options.skipPathParts ?? DEFAULT_SKIP_PARTS
  const found: SourceFile[] = []

  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      const relPath = rel === '' ? entry : `${rel}/${entry}`
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        if (skipDirs.has(entry)) continue
        walk(abs, relPath)
        continue
      }
      if (!extensions.some((ext) => entry.endsWith(ext))) continue
      if (skipParts.some((part) => relPath.includes(part))) continue
      found.push({ path: relPath, content: readFileSync(abs, 'utf8') })
    }
  }

  walk(root, '')
  return found
}
