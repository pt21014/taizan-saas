/**
 * **从 `apps/**` 现场快照出 `templates/**`**（`pnpm build:templates`）。
 *
 * ## 为什么是脚本快照，不是手工副本
 *
 * 生成器交付的东西就是这个仓库的六个端。这六个端**每天都在改**（别的 agent 正在给
 * `apps/admin` 接真实接口、在动 `packages/prisma-base`）。手工维护一份副本意味着
 * 「模板落后于参考应用」是常态而不是异常，而这种落后没有任何信号——直到某个用户
 * 生成出来的项目里带着三周前的 bug。
 *
 * 所以：模板由脚本生成，进 git（发布要用），并且有 `--check` 模式在 CI 里比对
 * 「现在的 apps/ 再快照一次，与仓库里的 templates/ 逐字节一致吗」。改了 apps/ 忘了
 * 重跑 → CI 红 → 有人必须重新看一眼改写规则表还对不对。
 *
 * ## 一个文件走完的四步
 *
 * 1. **选**：`SOURCES` 白名单 + `SKIP` 黑名单。产物目录、`.env`、migrations 一律不进。
 * 2. **标**：按 `EXAMPLE_REGIONS` 算出「这份文件里哪几行属于示例业务」，在那些行
 *    前后插 `@taizan-example-start/end` 注释（裁剪期只认标记）。
 * 3. **改**：逐行过 `TEXT_RULES`（品牌 / 项目名 / 端口 / 域名 / 业务域 → `{{变量}}`）。
 *    `package.json` 额外走一步结构化改写：`@taizan/*` 框架依赖的 `workspace:*` 换成
 *    版本区间——生成出来的项目里**没有** `packages/` 目录，框架是从 npm 装的。
 * 4. **写**：内容里出现了 `{{` 就落成 `<name>.hbs`（渲染期去后缀），否则原样落盘。
 *
 * ## 用法
 *
 * ```bash
 * pnpm build:templates            # 重新快照
 * pnpm build:templates -- --check # 只比对，不写盘（CI 用），有漂移就非零退出
 * ```
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXAMPLE_REGIONS, type RegionRule } from '../src/example-regions'
import { FILE_PATCHES } from '../src/file-patches'
import { applyTextRules, commentPrefixFor, EXAMPLE_MARKER, isExampleFile } from '../src/rewrite'
import type { Bucket, Manifest, ManifestEntry } from '../src/types'
import { ALL_APPS } from '../src/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const TEMPLATES_DIR = join(PKG_ROOT, 'templates')

/** 写进生成项目 dependencies 的 `@taizan/*` 版本区间。 */
const TAIZAN_VERSION = '^0.1.0'

/**
 * 快照来源白名单。
 *
 * 白名单而不是「整个仓库减去黑名单」：仓库里有 `docs/`、`packages/`、`scripts/`、
 * `.changeset/*.md` 这些**只属于框架本身**的东西，它们不该出现在业务项目里。
 * 用黑名单的话每加一个框架侧目录就要记得去补一条，漏了就悄悄泄进模板。
 */
const SOURCES: ReadonlyArray<{ from: string; to: string; bucket: Bucket }> = [
  ...ALL_APPS.map((app) => ({ from: `apps/${app}`, to: `apps/${app}`, bucket: app as Bucket })),
  { from: 'deploy', to: 'deploy', bucket: 'deploy' },
  // migrations/ 整个目录是跳过的（见 SKIP_DIRS 的说明），但这一个文件要带走：
  // 它记的是 datasource provider，而 `base-schema-integrity.spec.ts` 有一条断言
  // 「迁移目录在 prisma/migrations 而不是 00-base/ 旁边」——目录不存在那条就红。
  {
    from: 'apps/api/prisma/migrations/migration_lock.toml',
    to: 'apps/api/prisma/migrations/migration_lock.toml',
    bucket: 'api',
  },
  { from: 'tools/tsconfig', to: 'tools/tsconfig', bucket: 'tools' },
  { from: 'tools/eslint-config', to: 'tools/eslint-config', bucket: 'tools' },
  { from: 'tools/prettier-config', to: 'tools/prettier-config', bucket: 'tools' },
  { from: 'tools/codegen', to: 'tools/codegen', bucket: 'tools' },
  { from: 'turbo.json', to: 'turbo.json', bucket: 'root' },
  { from: '.npmrc', to: '.npmrc', bucket: 'root' },
  { from: '.editorconfig', to: '.editorconfig', bucket: 'root' },
  { from: '.prettierignore', to: '.prettierignore', bucket: 'root' },
  { from: '.dockerignore', to: '.dockerignore', bucket: 'root' },
  // T4-4 写好的 CLAUDE.md 模板：它本来就是 .hbs，原样搬进来（不再过改写规则，
  // 否则它自己的 {{projectName}} 会被当成「源码里的花括号」转义掉）。
  { from: 'docs/templates/CLAUDE.md.hbs', to: 'CLAUDE.md.hbs', bucket: 'root' },
  // 生成器自己维护的那几份：根 package.json、README、CI、.gitignore、changeset 配置。
  // **不快照仓库根的同名文件**——那几份是「框架仓库」的（发布 @taizan/*、跑 packages/
  // 的测试、生成 ERROR-CODES.md），业务项目里一条都用不上，照搬过去只会是死配置。
  { from: 'tools/create-taizan-saas/extras', to: '.', bucket: 'root' },
]

/**
 * 跳过：产物、密钥、以及**迁移目录**。
 *
 * 迁移不带走的理由值得写下来：`prisma/migrations/*.sql` 里写死了 `Goods` 这个表名，
 * 而生成出来的项目业务域可能叫 `order`。带过去 = 第一条 migrate 就与 schema 对不上。
 * 生成项目的第一条迁移由它自己 `prisma migrate dev --name init` 生成。
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.turbo',
  '.swc',
  'coverage',
  'test-results',
  'playwright-report',
  '.playwright-mcp',
  'migrations',
  '.expo',
  '.output',
  '.vite',
  // 本地临时工作目录（谁都可能在包里开一个），永远不该进模板。
  '.tmp',
  'tmp',
])

/**
 * 精确路径跳过：源码树里混进去的构建期产物。
 *
 * `robots.txt`/`sitemap.xml` 不需要在这里列——它们生成到 `dist/`，整个目录已经在
 * `SKIP_DIRS` 里。但 `apps/site/src/styles/tokens.css` 是个例外：
 * `scripts/generate-tokens.ts` 把它写进**源码树**（`src/styles/`，不是 `dist/`），
 * 而这个脚本用 `readdirSync` 直接扫磁盘——本地跑过一次 `pnpm -F @taizan/site dev|build`
 * 之后它就物理存在于 `apps/site/src/styles/` 下，`walk()` 会照单全收，把它当成
 * 「apps/ 里的源文件」快照进 templates/。它现在已经从 git 里移除（见
 * `apps/site/.gitignore`），但只要在磁盘上存在就必须显式排除，不能指望它「不存在」。
 */
const SKIP_FILES = new Set(['apps/site/src/styles/tokens.css'])

/** 跳过的文件（精确名或后缀）。 */
function shouldSkipFile(name: string, repoRel: string): boolean {
  if (name === '.DS_Store' || name.endsWith('.log') || name.endsWith('.tsbuildinfo')) return true
  // .env 是本机私货；.env.example 必须带走（生成项目靠它启动）。
  if (name === '.env' || (name.startsWith('.env.') && !name.endsWith('.example'))) return true
  if (repoRel.endsWith('.last-run.json')) return true
  if (SKIP_FILES.has(repoRel)) return true
  return false
}

/** 按后缀判定二进制（直拷、不改写、不算 `.hbs`）。 */
const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|mp3|wav|pdf|zip|gz|tgz|jar|so|dll|node|wasm)$/i

interface Collected {
  /** 相对 templates/ 的 POSIX 路径（可能带 .hbs）。 */
  path: string
  source: string
  bucket: Bucket
  binary: boolean
  render: boolean
  content: Buffer
}

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const VERBOSE = args.includes('--verbose')

main()

function main(): void {
  const collected: Collected[] = []
  const ruleHits = new Map<string, number>()

  for (const src of SOURCES) {
    const absFrom = join(REPO_ROOT, src.from)
    if (!existsSync(absFrom)) {
      // extras/ 在首次跑之前可能还不存在；其余来源缺失是真的错。
      if (src.from.endsWith('/extras')) continue
      throw new Error(`[build-templates] 快照来源不存在：${src.from}`)
    }
    if (statSync(absFrom).isDirectory()) {
      walk(absFrom, src.from, src.to, src.bucket, collected, ruleHits)
    } else {
      const rel = src.from
      const entry = transformFile(absFrom, rel, src.to, src.bucket, ruleHits)
      if (entry) collected.push(entry)
    }
  }

  collected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const manifest: Manifest = {
    frameworkVersion: JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version,
    taizanVersion: TAIZAN_VERSION,
    generatedAt: new Date().toISOString(),
    files: collected.map<ManifestEntry>((c) => ({
      path: c.path,
      source: c.source,
      sha256: sha256(c.content),
      bucket: c.bucket,
      render: c.render,
      binary: c.binary,
    })),
  }

  if (CHECK_ONLY) {
    check(collected, manifest)
    return
  }

  rmSync(TEMPLATES_DIR, { recursive: true, force: true })
  for (const c of collected) {
    const dest = join(TEMPLATES_DIR, c.path.split('/').join(sep))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, c.content)
  }
  writeFileSync(join(TEMPLATES_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  const byBucket = new Map<string, number>()
  for (const c of collected) byBucket.set(c.bucket, (byBucket.get(c.bucket) ?? 0) + 1)
  console.log(`[build-templates] ${collected.length} 个文件 → templates/`)
  for (const [bucket, n] of [...byBucket].sort()) console.log(`  ${bucket.padEnd(14)} ${n}`)
  console.log(`[build-templates] 需渲染 .hbs：${collected.filter((c) => c.render).length}`)
  if (VERBOSE) {
    console.log('[build-templates] 改写规则命中次数：')
    for (const [id, n] of [...ruleHits].sort()) console.log(`  ${id.padEnd(4)} ${n}`)
  }
}

/** `--check`：与磁盘上的 templates/ 逐文件比对。 */
function check(collected: Collected[], fresh: Manifest): void {
  const manifestPath = join(TEMPLATES_DIR, 'manifest.json')
  if (!existsSync(manifestPath)) {
    fail(['templates/manifest.json 不存在——先跑一次 `pnpm build:templates`。'])
  }
  const onDisk = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
  const problems: string[] = []

  const diskMap = new Map(onDisk.files.map((f) => [f.path, f]))
  const freshMap = new Map(fresh.files.map((f) => [f.path, f]))

  for (const f of fresh.files) {
    const d = diskMap.get(f.path)
    if (!d) {
      problems.push(`新增（apps/ 里有、templates/ 里没有）：${f.path}  ← ${f.source}`)
      continue
    }
    if (d.sha256 !== f.sha256) {
      problems.push(`内容漂移：${f.path}  ← ${f.source}`)
    }
  }
  for (const d of onDisk.files) {
    if (!freshMap.has(d.path)) problems.push(`已删除（templates/ 里有、apps/ 里没有）：${d.path}`)
  }
  // manifest 记的 sha 与磁盘上真实文件也要对得上（有人手改了 templates/）。
  for (const d of onDisk.files) {
    const abs = join(TEMPLATES_DIR, d.path.split('/').join(sep))
    if (!existsSync(abs)) {
      problems.push(`manifest 里有但文件不在：${d.path}`)
      continue
    }
    if (sha256(readFileSync(abs)) !== d.sha256) {
      problems.push(`templates/ 被手改过（与 manifest 的 sha256 不符）：${d.path}`)
    }
  }

  if (problems.length > 0) fail(problems)
  console.log(`[build-templates --check] ${fresh.files.length} 个模板文件与 apps/ 一致。`)
}

function fail(problems: string[]): never {
  console.error('[build-templates --check] 模板与 apps/ 不一致：\n')
  for (const p of problems) console.error(`  · ${p}`)
  console.error(
    '\n修法：`pnpm build:templates` 重新快照，然后**看一眼 diff**——' +
      '改写规则表（tools/create-taizan-saas/src/rewrite.ts）可能需要跟着改。\n',
  )
  process.exit(1)
}

function walk(
  absDir: string,
  repoRelDir: string,
  destRelDir: string,
  bucket: Bucket,
  out: Collected[],
  ruleHits: Map<string, number>,
): void {
  for (const name of readdirSync(absDir).sort()) {
    const abs = join(absDir, name)
    const repoRel = posix.join(repoRelDir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      walk(abs, repoRel, posix.join(destRelDir, name), bucket, out, ruleHits)
      continue
    }
    if (shouldSkipFile(name, repoRel)) continue
    const entry = transformFile(abs, repoRel, posix.join(destRelDir, name), bucket, ruleHits)
    if (entry) out.push(entry)
  }
}

/** 一个文件的四步（选/标/改/写）里的中间三步。 */
function transformFile(
  abs: string,
  repoRel: string,
  destRel: string,
  bucket: Bucket,
  ruleHits: Map<string, number>,
): Collected | null {
  const raw = readFileSync(abs)
  const normalizedDest = destRel.startsWith('./') ? destRel.slice(2) : destRel

  if (BINARY_EXT.test(repoRel) || raw.includes(0)) {
    return {
      path: normalizedDest,
      source: repoRel,
      bucket,
      binary: true,
      render: false,
      content: raw,
    }
  }

  // **统一成 LF**：仓库里混着 CRLF（Windows 上编辑过的文件）。不归一的话
  // 「按行匹配标记规则」会全部失配（行尾多一个回车符），而失配的表现是
  // 「示例标记一条都没插上」——那正是最不该静默的一类错。
  // 模板一律以 LF 落盘，渲染出来的项目也就一律是 LF（与 .editorconfig 一致）。
  let text = normalizeEol(raw.toString('utf8'))

  // 源文件本来就是 `.hbs` 的两类，都不再过一遍改写规则（否则它们自己的
  // `{{projectName}}` 会被当成「源码里的花括号」转义掉），但去向完全不同：
  //
  // · `docs/templates/CLAUDE.md.hbs` —— 生成项目时**要渲染**成 CLAUDE.md；
  // · `tools/codegen/templates/**.hbs` —— 是 codegen 自己的模板，**原样带走**，
  //   `.hbs` 后缀必须留着（生成项目里 `pnpm gen:module` 还要用它们）。
  //   把它们当成生成器模板去渲染，等于在生成项目的那一刻就把 codegen 的占位符
  //   全部填成空字符串，脚手架从此产出一堆没有名字的文件。
  if (repoRel.endsWith('.hbs')) {
    const verbatim = repoRel.startsWith('tools/codegen/templates/')
    return {
      path: normalizedDest,
      source: repoRel,
      bucket,
      binary: false,
      render: !verbatim,
      content: Buffer.from(text, 'utf8'),
    }
  }

  if (repoRel.endsWith('package.json')) text = rewritePackageJson(text)
  text = applyFilePatches(repoRel, text)

  const regions = computeRegions(repoRel, text)
  const marker = commentPrefixFor(repoRel)
  const wholeFileIsExample = isExampleFile(repoRel)

  const lines = text.split('\n')
  const outLines: string[] = []
  const starts = new Map(regions.map((r) => [r[0], r]))
  const ends = new Set(regions.map((r) => r[1]))

  for (let i = 0; i < lines.length; i++) {
    if (starts.has(i) && marker) outLines.push(markerLine(marker, `${EXAMPLE_MARKER}-start`))
    const inRegion = wholeFileIsExample || regions.some(([a, b]) => i >= a && i <= b)
    const { output, applied } = applyTextRules(repoRel, lines[i] as string, inRegion)
    for (const id of applied) ruleHits.set(id, (ruleHits.get(id) ?? 0) + 1)
    outLines.push(output)
    if (ends.has(i) && marker) outLines.push(markerLine(marker, `${EXAMPLE_MARKER}-end`))
  }

  const finalText = outLines.join('\n')
  const needsRender = finalText.includes('{{')

  return {
    path: needsRender ? `${normalizedDest}.hbs` : normalizedDest,
    source: repoRel,
    bucket,
    binary: false,
    render: needsRender,
    content: Buffer.from(finalText, 'utf8'),
  }
}

/**
 * 应用 `FILE_PATCHES` 里属于这个文件的定点改写。
 *
 * 每条必须**恰好命中一次**：0 次说明 apps/ 改了而这张表没跟上，
 * 2 次说明 `find` 写得不够独特（替换掉哪一处是随机的）。两种都直接抛。
 */
function applyFilePatches(repoRel: string, text: string): string {
  let out = text
  for (const patch of FILE_PATCHES) {
    if (patch.file !== repoRel) continue
    const hits = out.split(patch.find).length - 1
    if (hits !== 1) {
      throw new Error(
        `[build-templates] 定点改写漂移：${repoRel} 里「${patch.why}」这条 patch 命中 ${hits} 次（应为 1）。` +
          '\n  apps/ 改了而 src/file-patches.ts 没跟着改。不要把这条 patch 删掉了事——' +
          '\n  它守的是「生成出来的项目 pnpm test 能不能跑」。',
      )
    }
    out = out.split(patch.find).join(patch.replace)
  }
  return out
}

/** 按文件类型拼一行标记注释。 */
function markerLine(prefix: string, body: string): string {
  if (prefix === '<!--') return `<!-- @${body} -->`
  return `${prefix} @${body}`
}

/**
 * 算出这份文件里属于示例业务的行区间（0 基、闭区间）。
 *
 * 每条规则都**必须命中期望次数**，否则直接抛——这张表是「示例散在哪」的唯一记录，
 * 静默漏掉一条的代价是用户选了「不要示例」却拿到一个编译不过的项目。
 */
function computeRegions(repoRel: string, text: string): Array<[number, number]> {
  const rules = EXAMPLE_REGIONS[repoRel]
  if (!rules) return []
  const lines = text.split('\n')
  const regions: Array<[number, number]> = []

  for (const rule of rules) {
    const hits = matchRule(rule, lines)
    const want = rule.times ?? 1
    if (hits.length !== want) {
      throw new Error(
        `[build-templates] 示例标记规则漂移：${repoRel} 的规则「${rule.why}」期望命中 ${want} 次，` +
          `实际 ${hits.length} 次。\n` +
          '  apps/ 改了而 src/example-regions.ts 没跟着改。去那张表里对一遍，' +
          '不要把 times 调成实际值了事——那等于放弃「不保留示例」这条路。',
      )
    }
    regions.push(...hits)
  }
  return mergeRegions(regions)
}

function matchRule(rule: RegionRule, lines: string[]): Array<[number, number]> {
  const found: Array<[number, number]> = []
  for (let i = 0; i < lines.length; i++) {
    if (!rule.from.test(lines[i] as string)) continue
    let end = i
    if (rule.to) {
      end = -1
      for (let j = i; j < lines.length; j++) {
        if (rule.to.test(lines[j] as string)) {
          end = j
          break
        }
      }
      if (end === -1) continue
    }
    found.push([Math.max(0, i - (rule.lead ?? 0)), end])
    i = end
  }
  return found
}

/** 区间合并（相邻/重叠的并成一段，免得插出嵌套标记）。 */
function mergeRegions(regions: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...regions].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else out.push([...r] as [number, number])
  }
  return out
}

/**
 * `package.json` 的结构化改写：`@taizan/*` 框架包的 `workspace:*` → 版本区间。
 *
 * 生成出来的项目**没有** `packages/` 目录——框架是从 npm 装的。留着 `workspace:*`
 * 会让 `pnpm install` 直接报「找不到 workspace 包」。
 *
 * 七个端与三个共享配置包**保持 `workspace:*`**：它们的源码真的被拷进去了，
 * 在生成项目里仍然是 workspace 成员（`{{scope}}/tsconfig` 之类）。
 * 这一步在文本改写之前跑，所以这里看到的还是 `@taizan/xxx` 原名。
 */
function rewritePackageJson(text: string): string {
  const pkg = JSON.parse(text) as Record<string, unknown>
  const localNames = new Set<string>([
    ...ALL_APPS.map((a) => `@taizan/${a}`),
    '@taizan/tsconfig',
    '@taizan/eslint-config',
    '@taizan/prettier-config',
    '@taizan/codegen',
  ])
  let changed = false
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = pkg[field] as Record<string, string> | undefined
    if (!deps) continue
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith('@taizan/')) continue
      if (localNames.has(name)) continue
      if (!range.startsWith('workspace:')) continue
      deps[name] = TAIZAN_VERSION
      changed = true
    }
  }
  return changed ? JSON.stringify(pkg, null, 2) + '\n' : text
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** CRLF → LF。见 `transformFile` 里的注释。 */
function normalizeEol(text: string): string {
  return text.split('\r\n').join('\n')
}
