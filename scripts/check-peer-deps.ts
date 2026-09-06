#!/usr/bin/env node
/**
 * scripts/check-peer-deps.ts — T4-6 版本与发布治理
 *
 * 校验全仓 packages/* 是否满足「可安全公开发布到 npm」的五条硬规则：
 *   ① 蓝图标为「零框架依赖」的包，dependencies 里不得出现框架/运行时污染依赖
 *      （@nestjs/*、@prisma/client、react、@tarojs/*、expo）；这些包必须能在裸 node 里跑单测。
 *   ② Nest 适配九件套，把 @nestjs/*、@prisma/client、ioredis、bullmq、rxjs 放在
 *      peerDependencies 而不是 dependencies（否则会把某个具体版本焊死给所有下游）。
 *   ③ 所有 @taizan/* 内部依赖（dependencies / devDependencies）必须用 workspace:*，
 *      不允许写死具体版本号（那样发布时 changesets 才能正确改写为真实版本号）。
 *   ④ 每个「应当可发布」的包都要有 exports / types / files，且 publishConfig.access
 *      为 "public"（scoped 包默认是 restricted，不显式声明会发布失败或需要每次手输 --access）。
 *   ⑤ 被 .changeset/config.json 归入同一个 linked 组（当前是 9 个 @taizan/nest-*）的包，
 *      version 字段必须彼此一致。
 *
 * 用法：
 *   pnpm check:peer-deps          （从仓库根目录执行；根 package.json 已接好这个 script）
 *
 * 设计说明——为什么清单是硬编码在本文件里，而不是从 package.json 的 private/dependencies 反推：
 *   如果"什么算零框架依赖包""什么算应当公开发布的包"这件事本身是从当前 package.json 读出来的，
 *   那么只要有人把依赖放错字段、或者把不该 private 的包标成 private，这条检查就会自动"跟着错"一起通过。
 *   这条脚本存在的意义就是拿"设计意图"（蓝图 §2 + .changeset/config.json）去校验"当前实现"，
 *   两者不一致时必须红，而不是放宽规则去迁就现状。
 *
 * 哨兵自检：脚本启动时先用内置的"坏样例"（故意违反每条规则的假 package.json）跑一遍五个校验函数，
 * 如果校验函数没能抓出这些坏样例（比如正则写挂了），脚本会在检查真实仓库之前就以非零退出，
 * 防止"检查逻辑本身失效但看起来一切正常"的假绿。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// ---------------------------------------------------------------------------
// 硬编码清单（来源见注释）
// ---------------------------------------------------------------------------

/**
 * 来源：docs/框架设计蓝图.md §2 包清单，"零框架依赖"列标 ✅ 的包（目录名，不含 @taizan/ 前缀）。
 * 含仅 CLI 的 prisma-base（peer 只允许 `prisma` 这个 CLI 包本身，不允许 `@prisma/client` 出现在 dependencies）
 * 与前端三个包 admin-ui / client-core / app-ui（允许 react / @tarojs/* / expo 作为 peerDependencies，
 * 但同样不能出现在 dependencies —— 蓝图原文："零依赖"在这里的意思是"不把框架焊死在 dependencies 里"，
 * 而不是"完全不能声明兼容的框架版本"）。
 * app-ui 对应 T3-7，本次盘点时尚未落地，脚本发现目录缺失会跳过并给出提示，不算失败。
 */
const ZERO_DEP_PACKAGES = [
  'contracts',
  'tenant-scope',
  'rbac-core',
  'billing-rules',
  'ratelimit-core',
  'crypto',
  'provision',
  'payment-core',
  'wechatpay',
  'wechat-open',
  'sms',
  'storage',
  'prisma-base',
  'tokens',
  'admin-ui',
  'client-core',
  'app-ui',
]

/** 零框架依赖包的 dependencies 里不允许出现的包名匹配规则 */
const FORBIDDEN_IN_ZERO_DEP: Array<{ test: (name: string) => boolean; label: string }> = [
  { test: (name) => /^@nestjs\//.test(name), label: '@nestjs/*' },
  { test: (name) => name === '@prisma/client', label: '@prisma/client' },
  { test: (name) => name === 'react', label: 'react' },
  { test: (name) => /^@tarojs\//.test(name), label: '@tarojs/*' },
  { test: (name) => name === 'expo', label: 'expo' },
]

/**
 * 来源：docs/框架设计蓝图.md §2「Nest 适配 9 个」+ .changeset/config.json 的 linked 分组。
 */
const NEST_ADAPTER_PACKAGES = [
  'nest-core',
  'nest-prisma',
  'nest-auth',
  'nest-rbac',
  'nest-billing',
  'nest-infra',
  'nest-audit',
  'nest-notify',
  'nest-payment',
]

/** Nest 适配包必须走 peerDependencies、不能固化在 dependencies 里的包名匹配规则 */
const MUST_BE_PEER: Array<{ test: (name: string) => boolean; label: string }> = [
  { test: (name) => /^@nestjs\//.test(name), label: '@nestjs/*' },
  { test: (name) => name === '@prisma/client', label: '@prisma/client' },
  { test: (name) => name === 'ioredis', label: 'ioredis' },
  { test: (name) => name === 'bullmq', label: 'bullmq' },
  { test: (name) => name === 'rxjs', label: 'rxjs' },
]

/**
 * 不会发布到 npm 的包（apps 与 tools 配置包），与 .changeset/config.json 的 ignore 保持一致。
 * 其余出现在 packages/* 下的目录，一律按"应当可发布"来源检查 rule ④ ——
 * 即便它们当前 package.json 里仍写着 private:true、没有 publishConfig（这正是本脚本要抓的真实违规，
 * 详见运行报告）。
 */
const IGNORED_PACKAGE_NAMES = new Set([
  '@taizan/_smoke',
  '@taizan/api',
  '@taizan/client',
  '@taizan/eslint-config',
  '@taizan/prettier-config',
  '@taizan/tsconfig',
])

// ---------------------------------------------------------------------------
// 类型与工具
// ---------------------------------------------------------------------------

interface PackageJson {
  name: string
  version?: string
  private?: boolean
  main?: string
  types?: string
  exports?: unknown
  files?: string[]
  publishConfig?: { access?: string; [k: string]: unknown }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface LoadedPackage {
  dir: string
  relDir: string
  pkg: PackageJson
}

interface Violation {
  rule: string
  pkg: string
  detail: string
}

function readWorkspaceGlobs(root: string): string[] {
  const raw = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const lines = raw.split(/\r?\n/)
  const globs: string[] = []
  let inPackages = false
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      if (/^\S/.test(line)) break // 到了下一个顶层 key，packages 列表结束
      const m = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/)
      if (m) globs.push(m[1])
    }
  }
  if (globs.length === 0) {
    throw new Error('pnpm-workspace.yaml 未解析出任何 packages 列表，检查文件格式是否变了')
  }
  return globs
}

function loadWorkspacePackages(root: string): LoadedPackage[] {
  const globs = readWorkspaceGlobs(root)
  const result: LoadedPackage[] = []
  for (const glob of globs) {
    // 本仓库的 workspace glob 目前都是 "<dir>/*" 形式，按此约定展开即可
    const base = glob.replace(/\/\*$/, '')
    const baseAbs = join(root, base)
    if (!existsSync(baseAbs)) continue
    for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(baseAbs, entry.name)
      const pkgPath = join(dir, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson
      result.push({ dir, relDir: `${base}/${entry.name}`, pkg })
    }
  }
  return result
}

function depEntries(
  pkg: PackageJson,
  field: 'dependencies' | 'devDependencies' | 'peerDependencies',
) {
  return Object.entries(pkg[field] ?? {})
}

// ---------------------------------------------------------------------------
// 五条规则的校验函数（哨兵自检与真实检查复用同一份实现）
// ---------------------------------------------------------------------------

/** 规则① */
function checkZeroDep(pkg: PackageJson): Violation[] {
  const violations: Violation[] = []
  for (const [depName] of depEntries(pkg, 'dependencies')) {
    const hit = FORBIDDEN_IN_ZERO_DEP.find((rule) => rule.test(depName))
    if (hit) {
      violations.push({
        rule: '①零框架依赖',
        pkg: pkg.name,
        detail: `dependencies 中出现 "${depName}"（属于 ${hit.label}），零框架依赖包不得依赖框架/运行时`,
      })
    }
  }
  return violations
}

/** 规则② */
function checkNestPeer(pkg: PackageJson): Violation[] {
  const violations: Violation[] = []
  for (const [depName] of depEntries(pkg, 'dependencies')) {
    const hit = MUST_BE_PEER.find((rule) => rule.test(depName))
    if (hit) {
      violations.push({
        rule: '②peer化',
        pkg: pkg.name,
        detail: `"${depName}"（属于 ${hit.label}）出现在 dependencies，Nest 适配包必须把它放进 peerDependencies`,
      })
    }
  }
  return violations
}

/** 规则③ */
function checkWorkspaceProtocol(pkg: PackageJson): Violation[] {
  const violations: Violation[] = []
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const [depName, range] of depEntries(pkg, field)) {
      if (depName.startsWith('@taizan/') && range !== 'workspace:*') {
        violations.push({
          rule: '③workspace协议',
          pkg: pkg.name,
          detail: `${field}.${depName} = "${range}"，内部依赖必须写 "workspace:*"`,
        })
      }
    }
  }
  return violations
}

/** 规则④ */
function checkPublishMeta(pkg: PackageJson): Violation[] {
  const violations: Violation[] = []
  const missing: string[] = []
  if (!pkg.exports) missing.push('exports')
  if (!pkg.types) missing.push('types')
  if (!pkg.files || pkg.files.length === 0) missing.push('files')
  if (missing.length > 0) {
    violations.push({
      rule: '④发布元数据',
      pkg: pkg.name,
      detail: `缺少字段：${missing.join(', ')}`,
    })
  }
  if (pkg.publishConfig?.access !== 'public') {
    violations.push({
      rule: '④发布元数据',
      pkg: pkg.name,
      detail: `publishConfig.access 应为 "public"，实际为 ${JSON.stringify(pkg.publishConfig?.access) ?? 'undefined'}（scoped 包默认 restricted，不声明会发布失败）`,
    })
  }
  return violations
}

/** 规则⑤：linked 组内版本必须一致（跨包比较，单独处理，不走单包 checker 签名） */
function checkLinkedVersions(pkgs: LoadedPackage[], linkedNames: string[]): Violation[] {
  const violations: Violation[] = []
  const versions = new Map<string, string>()
  for (const { pkg } of pkgs) {
    if (linkedNames.includes(pkg.name) && pkg.version) {
      versions.set(pkg.name, pkg.version)
    }
  }
  const uniqueVersions = new Set(versions.values())
  if (uniqueVersions.size > 1) {
    for (const [name, version] of versions) {
      violations.push({
        rule: '⑤linked一致性',
        pkg: name,
        detail: `linked 组（@taizan/nest-*）内版本不一致：当前为 ${version}，组内还有 ${[...uniqueVersions].filter((v) => v !== version).join(', ')}`,
      })
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// 哨兵自检：内置坏样例必须被上面的 checker 抓出来，否则先于真实检查报错退出
// ---------------------------------------------------------------------------

function selfTest(): void {
  const failures: string[] = []

  // 规则①：坏样例应命中，好样例不应命中
  const badZeroDep: PackageJson = {
    name: '@taizan/__sentinel-zero-dep-bad',
    dependencies: { '@nestjs/common': '^11.0.0' },
  }
  const goodZeroDep: PackageJson = {
    name: '@taizan/__sentinel-zero-dep-good',
    dependencies: { '@taizan/contracts': 'workspace:*' },
  }
  if (checkZeroDep(badZeroDep).length === 0)
    failures.push('checkZeroDep 未能识别坏样例（@nestjs/common 混入 dependencies）')
  if (checkZeroDep(goodZeroDep).length !== 0) failures.push('checkZeroDep 对合法样例误报')

  // 规则②
  const badNestPeer: PackageJson = {
    name: '@taizan/__sentinel-nest-bad',
    dependencies: { bullmq: '^5.0.0' },
  }
  const goodNestPeer: PackageJson = {
    name: '@taizan/__sentinel-nest-good',
    dependencies: {},
    peerDependencies: { bullmq: '^5.0.0' },
  }
  if (checkNestPeer(badNestPeer).length === 0)
    failures.push('checkNestPeer 未能识别坏样例（bullmq 混入 dependencies）')
  if (checkNestPeer(goodNestPeer).length !== 0) failures.push('checkNestPeer 对合法样例误报')

  // 规则③
  const badWorkspace: PackageJson = {
    name: '@taizan/__sentinel-ws-bad',
    dependencies: { '@taizan/contracts': '^0.1.0' },
  }
  const goodWorkspace: PackageJson = {
    name: '@taizan/__sentinel-ws-good',
    dependencies: { '@taizan/contracts': 'workspace:*' },
  }
  if (checkWorkspaceProtocol(badWorkspace).length === 0)
    failures.push('checkWorkspaceProtocol 未能识别坏样例（内部依赖写死版本号）')
  if (checkWorkspaceProtocol(goodWorkspace).length !== 0)
    failures.push('checkWorkspaceProtocol 对合法样例误报')

  // 规则④
  const badPublish: PackageJson = { name: '@taizan/__sentinel-pub-bad', version: '0.1.0' }
  const goodPublish: PackageJson = {
    name: '@taizan/__sentinel-pub-good',
    version: '0.1.0',
    types: './dist/index.d.ts',
    exports: { '.': './dist/index.js' },
    files: ['dist'],
    publishConfig: { access: 'public' },
  }
  if (checkPublishMeta(badPublish).length === 0)
    failures.push('checkPublishMeta 未能识别坏样例（缺 exports/types/files/publishConfig）')
  if (checkPublishMeta(goodPublish).length !== 0) failures.push('checkPublishMeta 对合法样例误报')

  // 规则⑤
  const linkedBad: LoadedPackage[] = [
    { dir: '', relDir: '', pkg: { name: '@taizan/nest-core', version: '0.1.0' } },
    { dir: '', relDir: '', pkg: { name: '@taizan/nest-auth', version: '0.2.0' } },
  ]
  const linkedGood: LoadedPackage[] = [
    { dir: '', relDir: '', pkg: { name: '@taizan/nest-core', version: '0.1.0' } },
    { dir: '', relDir: '', pkg: { name: '@taizan/nest-auth', version: '0.1.0' } },
  ]
  const linkedNames = ['@taizan/nest-core', '@taizan/nest-auth']
  if (checkLinkedVersions(linkedBad, linkedNames).length === 0)
    failures.push('checkLinkedVersions 未能识别坏样例（linked 组版本不一致）')
  if (checkLinkedVersions(linkedGood, linkedNames).length !== 0)
    failures.push('checkLinkedVersions 对合法样例误报')

  if (failures.length > 0) {
    console.error(
      '哨兵自检失败：以下校验函数未能正确识别内置坏样例，规则实现本身有问题，已阻止对真实仓库的检查：',
    )
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function printTable(violations: Violation[]): void {
  if (violations.length === 0) {
    console.log('未发现违规。')
    return
  }
  const headers = ['规则', '包', '详情']
  const rows = violations.map((v) => [v.rule, v.pkg, v.detail])
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stringWidth(s)))
  // 中文字符按 2 列宽估算，避免表格错位
  function stringWidth(s: string): number {
    let w = 0
    for (const ch of s) w += /[一-龥＀-￯]/.test(ch) ? 2 : 1
    return w
  }
  const widthsCjk = headers.map((h, i) =>
    Math.max(stringWidth(h), ...rows.map((r) => stringWidth(r[i]))),
  )
  const line = (cols: string[]) => cols.map((c, i) => pad(c, widthsCjk[i])).join(' | ')
  console.log(line(headers))
  console.log(widthsCjk.map((w) => '-'.repeat(w)).join('-|-'))
  for (const r of rows) console.log(line(r))
}

function main(): void {
  selfTest()

  const root = process.cwd()
  const loaded = loadWorkspacePackages(root)
  const byName = new Map(loaded.map((p) => [p.pkg.name, p]))

  const violations: Violation[] = []

  for (const dirName of ZERO_DEP_PACKAGES) {
    const found = loaded.find((p) => p.relDir === `packages/${dirName}`)
    if (!found) {
      console.log(`[跳过] packages/${dirName} 尚未创建（规则①），后续任务落地后请重新跑本脚本`)
      continue
    }
    violations.push(...checkZeroDep(found.pkg))
  }

  for (const dirName of NEST_ADAPTER_PACKAGES) {
    const found = loaded.find((p) => p.relDir === `packages/${dirName}`)
    if (!found) {
      console.log(`[跳过] packages/${dirName} 尚未创建（规则②）`)
      continue
    }
    violations.push(...checkNestPeer(found.pkg))
  }

  for (const { pkg } of loaded) {
    violations.push(...checkWorkspaceProtocol(pkg))
  }

  for (const { pkg } of loaded) {
    if (IGNORED_PACKAGE_NAMES.has(pkg.name)) continue
    if (!pkg.name.startsWith('@taizan/')) continue
    // 只检查 packages/* 下的包，apps/* 与 tools/* 即使不在 ignore 名单里也不当作可发布包
    const isPackagesDir = loaded
      .find((p) => p.pkg.name === pkg.name)
      ?.relDir.startsWith('packages/')
    if (!isPackagesDir) continue
    violations.push(...checkPublishMeta(pkg))
  }

  const linkedNames = NEST_ADAPTER_PACKAGES.map((n) => `@taizan/${n}`)
  violations.push(...checkLinkedVersions(loaded, linkedNames))

  console.log(`\n共检查 ${loaded.length} 个 workspace 包，命中 ${violations.length} 条违规：\n`)
  printTable(violations)

  if (violations.length > 0) {
    console.error(`\ncheck:peer-deps 失败：共 ${violations.length} 条违规，详见上表。`)
    process.exit(1)
  }
  console.log('\ncheck:peer-deps 通过。')
}

main()
