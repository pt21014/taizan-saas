#!/usr/bin/env node
/**
 * scripts/check-changeset.mjs — T4-6 版本与发布治理
 *
 * 目的：如果这次改动碰了 packages/*\/src 下的源码，却没有新增 .changeset/*.md，
 * 就非零退出——防止「改了公开包的行为却忘了写 changeset，版本号和 CHANGELOG 永远不会更新」。
 *
 * 两种模式：
 *   本地（pre-commit / 手动自检）：
 *     node scripts/check-changeset.mjs --staged
 *     比较 git 暂存区（已 `git add` 的内容）。
 *
 *   CI（GitHub Actions 的 PR 检查）：
 *     node scripts/check-changeset.mjs [--base=origin/main]
 *     默认比较 `git merge-base <base> HEAD` 到 HEAD 之间的改动；--base 可覆盖比较基准
 *     （不传时按 .changeset/config.json 的 baseBranch 取 origin/<baseBranch>，取不到则退回 origin/main）。
 *
 * 退出码：
 *   0 = 通过（要么没碰 packages/*\/src，要么碰了但也带了 changeset）
 *   1 = 违规（碰了 packages/*\/src 但没有 changeset）
 *   2 = 用法/环境错误（例如不在 git 仓库里跑）
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

function printHelp() {
  console.log(`用法：
  node scripts/check-changeset.mjs --staged           本地模式：检查 git 暂存区
  node scripts/check-changeset.mjs [--base=<ref>]     CI 模式：检查 <ref>...HEAD 之间的改动（默认 origin/main）
  node scripts/check-changeset.mjs --help             打印本帮助

规则：改动命中 packages/*/src/** 时，必须同时新增至少一个 .changeset/*.md（不含 README.md），
否则以非零退出。`)
}

function parseArgs(argv) {
  const args = { staged: false, base: undefined, help: false }
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') args.help = true
    else if (raw === '--staged') args.staged = true
    else if (raw.startsWith('--base=')) args.base = raw.slice('--base='.length)
    else {
      console.error(`未知参数：${raw}`)
      process.exit(2)
    }
  }
  return args
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function readBaseBranchFromConfig(root) {
  const configPath = join(root, '.changeset', 'config.json')
  if (!existsSync(configPath)) return 'main'
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    return config.baseBranch ?? 'main'
  } catch {
    return 'main'
  }
}

function getChangedFiles({ staged, base, root }) {
  if (staged) {
    const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    return out ? out.split('\n') : []
  }
  const baseBranch = readBaseBranchFromConfig(root)
  const ref = base ?? `origin/${baseBranch}`
  let mergeBase
  try {
    mergeBase = git(['merge-base', ref, 'HEAD'])
  } catch {
    // 拿不到 merge-base（比如浅克隆、或 ref 不存在）时退化为直接 diff ref...HEAD
    mergeBase = ref
  }
  const out = git(['diff', '--name-only', '--diff-filter=ACMR', `${mergeBase}...HEAD`])
  return out ? out.split('\n') : []
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const root = process.cwd()
  let changedFiles
  try {
    changedFiles = getChangedFiles({ staged: args.staged, base: args.base, root })
  } catch (err) {
    console.error('无法读取 git 差异，确认当前目录是仓库根目录且历史可用：', err.message)
    process.exit(2)
    return
  }

  const touchedSrc = changedFiles.filter((f) => /^packages\/[^/]+\/src\//.test(f))
  const hasChangeset = changedFiles.some(
    (f) => /^\.changeset\/[^/]+\.md$/.test(f) && !/^\.changeset\/README\.md$/.test(f),
  )

  if (touchedSrc.length === 0) {
    console.log('未改动 packages/*/src，跳过 changeset 检查。')
    process.exit(0)
  }

  if (hasChangeset) {
    console.log(
      `检测到 ${touchedSrc.length} 个 packages/*/src 文件改动，且已包含 changeset，通过。`,
    )
    process.exit(0)
  }

  console.error('改动了以下 packages/*/src 文件，但没有新增 .changeset/*.md：')
  for (const f of touchedSrc) console.error(`  - ${f}`)
  console.error('\n请运行 `pnpm changeset` 补一个 changeset 再提交（哪怕是 patch）。')
  process.exit(1)
}

main()
