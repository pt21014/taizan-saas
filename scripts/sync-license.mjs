#!/usr/bin/env node
/**
 * 把根目录 `LICENSE` 复制到每个可发布包的目录里。
 *
 * 为什么要复制：npm 打包只看包自己的目录，不会把 monorepo 根的 LICENSE 带进 tarball。
 * 不复制的话，从 npm 装下来的 `@taizan/*` 包里只有 package.json 的 `"license": "MIT"` 一个字段，
 * 没有许可证原文——而 MIT 要求分发时附带版权与许可声明。npm 对 `LICENSE` 文件总是打包，
 * 与 `files` 字段无关，所以只要文件在包目录里就够了。
 *
 * 「可发布」= `packages/*` 与 `tools/*` 下 package.json 没有 `"private": true` 的包。
 * 新增包时跑一次 `pnpm license:sync`，把生成的 LICENSE 一起提交；CI 跑 `--check` 守着。
 *
 * 用法：
 *   node scripts/sync-license.mjs            # 写入各包目录的 LICENSE
 *   node scripts/sync-license.mjs --check    # 只比对，缺失或不一致则非零退出（CI 用）
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'LICENSE')
const SCAN_DIRS = ['packages', 'tools']

/** 列出全部可发布包的目录（绝对路径），按路径排序。 */
function publishableDirs() {
  const dirs = []
  for (const base of SCAN_DIRS) {
    const abs = join(ROOT, base)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkgFile = join(abs, entry.name, 'package.json')
      if (!existsSync(pkgFile)) continue
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      if (pkg.private === true) continue
      dirs.push(join(abs, entry.name))
    }
  }
  return dirs.sort()
}

function main() {
  const check = process.argv.includes('--check')
  if (!existsSync(SOURCE)) {
    console.error('[sync-license] 根目录 LICENSE 不存在。')
    process.exit(1)
  }
  const license = readFileSync(SOURCE, 'utf8')
  const norm = (s) => s.replace(/\r\n/g, '\n')
  const dirs = publishableDirs()

  if (!check) {
    for (const dir of dirs) writeFileSync(join(dir, 'LICENSE'), license, 'utf8')
    console.log(`[sync-license] 已写入 ${dirs.length} 个包的 LICENSE`)
    return
  }

  const problems = []
  for (const dir of dirs) {
    const target = join(dir, 'LICENSE')
    const rel = relative(ROOT, target).replace(/\\/g, '/')
    if (!existsSync(target)) problems.push(`  缺失：${rel}`)
    else if (norm(readFileSync(target, 'utf8')) !== norm(license)) problems.push(`  不一致：${rel}`)
  }
  if (problems.length > 0) {
    console.error(
      `[sync-license] ${problems.length} 个包的 LICENSE 与根目录不同步：\n` +
        problems.join('\n') +
        '\n  跑 `pnpm license:sync` 重新复制，并把改动一起提交。',
    )
    process.exit(1)
  }
  console.log(`[sync-license] ${dirs.length} 个可发布包的 LICENSE 与根目录一致 ✅`)
}

main()
