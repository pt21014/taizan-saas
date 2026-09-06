/**
 * 裁剪：把「没选的端」与「不要的示例模块」从**已经渲染好的目标目录**里拿掉，
 * 并把所有指向它们的引用一起收拾干净。
 *
 * ## 判据：裁剪之后不能有悬空引用
 *
 * 「删掉 `apps/admin/`」只是第一步。真正会咬人的是剩下的那些指针：
 *
 * - `deploy/nginx/admin.conf` 里 `root /www/wwwroot/admin.<域名>;` 指向一个永远不会
 *   出现的目录，nginx `-t` 能过，运行时是 404——最难查的那种「配置是对的但没用」。
 * - `deploy/docker/nginx-compose.conf` 里的 admin server 块同理。
 * - `apps/api/test/arch/menu-route-map.spec.ts` 会去读 `apps/admin/src/routes/component-map.ts`，
 *   文件不在就直接抛——`pnpm test` 当场红，而错误信息说的是「解析不出 componentKey」，
 *   与「你没选 admin 这个端」离得很远。
 *
 * 所以这个文件的每一条裁剪都配一条断言（`assertNoDanglingRefs`），单测里对
 * `turbo.json` / `pnpm-workspace.yaml` / nginx 做文本与 JSON 双向检查。
 *
 * ## 示例模块靠标记，不靠认代码
 *
 * `build-templates.ts` 在快照期就把示例相关的行用 `// @taizan-example-start/end`
 * 圈了起来。这里只做一件事：删掉标记之间的所有行（连标记本身）。保留示例时则只
 * 删掉标记行本身——生成出来的项目里不该留着这种给生成器看的注释。
 *
 * @packageDocumentation
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

import { EXAMPLE_ONLY_PATHS } from './example-regions'
import { renderText } from './render'
import { EXAMPLE_MARKER } from './rewrite'
import type { AppName, TemplateVars } from './types'
import { ALL_APPS } from './types'

/** 一个端被裁掉时，还要顺手删掉的部署文件。 */
const APP_DEPLOY_FILES: Readonly<Record<string, readonly string[]>> = {
  admin: ['deploy/nginx/admin.conf'],
  platform: ['deploy/nginx/platform.conf'],
  site: ['deploy/nginx/site.conf'],
  client: ['deploy/nginx/client.conf'],
}

export interface PruneReport {
  /** 删掉的目录 / 文件（相对项目根）。 */
  removed: string[]
  /** 改写过的文件。 */
  edited: string[]
  /** 生成完之后仍然需要人工处理的事（打印给用户看）。 */
  todos: string[]
}

/** 裁剪入口。`targetDir` 是已经渲染完的项目目录。 */
export function prune(targetDir: string, vars: TemplateVars): PruneReport {
  const report: PruneReport = { removed: [], edited: [], todos: [] }

  // ── 1. 没选的端：目录 + 部署配置 ──────────────────────────────────────
  const dropped = ALL_APPS.filter((a) => !vars.apps.includes(a))
  for (const app of dropped) {
    remove(targetDir, `apps/${app}`, report)
    for (const f of APP_DEPLOY_FILES[app] ?? []) remove(targetDir, f, report)
  }

  // ── 2. 引用清理 ──────────────────────────────────────────────────────
  pruneNginxCompose(targetDir, dropped, vars, report)
  // `apps/api/test/arch/menu-route-map.spec.ts` 里「admin / platform 可能不存在」的兜底
  // **不在这里**：它在快照期就改好了（src/file-patches.ts），所以每个生成项目拿到的都是
  // 同一份代码，而不是「裁剪过的项目和没裁剪的项目跑的是两份 spec」。

  // ── 3. 示例模块 ──────────────────────────────────────────────────────
  if (!vars.includeExample) {
    for (const p of EXAMPLE_ONLY_PATHS) remove(targetDir, renderText(p, vars), report)
    report.todos.push(
      'apps/api/src/seed.ts：示例数据已删，但 seed 里的「只读角色 / 受限员工」两段仍然引用 ' +
        `\`${vars.domainSlug}:list\` 这个权限点（它现在不存在了）。要么删掉那两段，` +
        '要么把权限点换成你自己模块的。它不会让编译红，但 seed 出来的角色会挂着一个死权限。',
      'apps/api/prisma/schema/10-business/ 现在是空目录：第一条业务表用 `pnpm gen:module <slug>` 生成。',
    )
  }
  stripExampleMarkers(targetDir, vars, report)

  // ── 4. 断言：不许留悬空引用 ──────────────────────────────────────────
  assertNoDanglingRefs(targetDir, vars)

  return report
}

/** 删一个文件或目录，记进报告。 */
function remove(targetDir: string, rel: string, report: PruneReport): void {
  const abs = join(targetDir, rel.split('/').join(sep))
  if (!existsSync(abs)) return
  rmSync(abs, { recursive: true, force: true })
  report.removed.push(rel)
}

/**
 * `deploy/docker/nginx-compose.conf`：删掉被裁端的 server 块。
 *
 * server 块靠 `server_name <app>.<域名>;` 认。不用正则去配对花括号——那份文件是
 * 我们自己快照来的，块与块之间有空行分隔，按 `server {` 切片再看每片里的
 * `server_name` 就够了，而且切错了下面的 `assertNoDanglingRefs` 会抓住。
 */
function pruneNginxCompose(
  targetDir: string,
  dropped: readonly AppName[],
  vars: TemplateVars,
  report: PruneReport,
): void {
  const rel = 'deploy/docker/nginx-compose.conf'
  const abs = join(targetDir, rel.split('/').join(sep))
  if (!existsSync(abs) || dropped.length === 0) return
  const text = readFileSync(abs, 'utf8')

  const blocks = splitServerBlocks(text)
  const kept = blocks.filter((b) => {
    if (!b.isServer) return true
    return !dropped.some((app) => new RegExp(`server_name\\s+[^;]*\\b${app}\\.`).test(b.text))
  })
  if (kept.length === blocks.length) return
  writeFileSync(abs, kept.map((b) => b.text).join(''), 'utf8')
  report.edited.push(rel)
}

/** 把 nginx 配置切成「server 块」与「块之间的东西」。 */
function splitServerBlocks(text: string): Array<{ isServer: boolean; text: string }> {
  const out: Array<{ isServer: boolean; text: string }> = []
  const lines = text.split('\n')
  let buf: string[] = []
  let depth = 0
  let inServer = false

  for (const line of lines) {
    if (!inServer && /^\s*server\s*\{/.test(line)) {
      if (buf.length > 0) out.push({ isServer: false, text: buf.join('\n') + '\n' })
      buf = [line]
      depth = countBraces(line)
      inServer = true
      continue
    }
    buf.push(line)
    if (inServer) {
      depth += countBraces(line)
      if (depth <= 0) {
        out.push({ isServer: true, text: buf.join('\n') + '\n' })
        buf = []
        inServer = false
      }
    }
  }
  if (buf.length > 0) out.push({ isServer: inServer, text: buf.join('\n') })
  return out
}

function countBraces(line: string): number {
  return (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
}

/**
 * 处理标记注释。
 *
 * - 不保留示例：删掉 start/end 之间的所有行（含标记）。
 * - 保留示例：只删标记行本身。生成出来的项目里留着 `@taizan-example-start`
 *   会让人以为「这几行是框架给的、不能改」，恰恰相反——那是最该照着改的几行。
 */
function stripExampleMarkers(targetDir: string, vars: TemplateVars, report: PruneReport): void {
  const startRe = new RegExp(`@${EXAMPLE_MARKER}-start`)
  const endRe = new RegExp(`@${EXAMPLE_MARKER}-end`)

  for (const abs of walkFiles(targetDir)) {
    if (!isTextFile(abs)) continue
    const text = readFileSync(abs, 'utf8')
    if (!startRe.test(text)) continue
    const lines = text.split('\n')
    const out: string[] = []
    let dropping = false
    for (const line of lines) {
      if (startRe.test(line)) {
        dropping = !vars.includeExample
        continue
      }
      if (endRe.test(line)) {
        dropping = false
        continue
      }
      if (!dropping) out.push(line)
    }
    writeFileSync(abs, out.join('\n'), 'utf8')
    report.edited.push(relOf(targetDir, abs))
  }
}

/**
 * 裁剪后自检：项目里不许再出现指向已删端的引用。
 *
 * 这不是「多做一层保险」，而是这个模块**唯一**能被自动验证的输出。裁剪本身是一串
 * 删文件/改文本的动作，正确与否只有靠「结果里没有悬空引用」来判定。
 */
export function assertNoDanglingRefs(targetDir: string, vars: TemplateVars): void {
  const problems: string[] = []
  const dropped = ALL_APPS.filter((a) => !vars.apps.includes(a))

  // pnpm-workspace.yaml 用的是 `apps/*` 通配，删目录就够了；万一将来改成逐条列举，
  // 这条断言会立刻发现。
  const wsPath = join(targetDir, 'pnpm-workspace.yaml')
  if (existsSync(wsPath)) {
    const ws = readFileSync(wsPath, 'utf8')
    for (const app of dropped) {
      if (ws.includes(`apps/${app}`)) problems.push(`pnpm-workspace.yaml 仍然点名了 apps/${app}`)
    }
  }

  const turboPath = join(targetDir, 'turbo.json')
  if (existsSync(turboPath)) {
    const turbo = readFileSync(turboPath, 'utf8')
    for (const app of dropped) {
      if (turbo.includes(`${vars.scope}/${app}`) || turbo.includes(`apps/${app}`)) {
        problems.push(`turbo.json 仍然点名了 ${app}`)
      }
    }
  }

  // 根 package.json 的脚本里可能有 `-F @scope/admin ...`。
  const rootPkgPath = join(targetDir, 'package.json')
  if (existsSync(rootPkgPath)) {
    const pkg = readFileSync(rootPkgPath, 'utf8')
    for (const app of dropped) {
      if (pkg.includes(`${vars.scope}/${app}`)) {
        problems.push(`根 package.json 的脚本仍然引用 ${vars.scope}/${app}`)
      }
    }
  }

  // nginx：既不该有独立 conf，也不该有 compose 里的 server 块。
  for (const app of dropped) {
    const conf = join(targetDir, 'deploy', 'nginx', `${app}.conf`)
    if (existsSync(conf)) problems.push(`deploy/nginx/${app}.conf 还在`)
  }
  const composeConf = join(targetDir, 'deploy', 'docker', 'nginx-compose.conf')
  if (existsSync(composeConf)) {
    const text = readFileSync(composeConf, 'utf8')
    for (const app of dropped) {
      if (new RegExp(`server_name\\s+[^;]*\\b${app}\\.`).test(text)) {
        problems.push(`deploy/docker/nginx-compose.conf 里还有 ${app} 的 server 块`)
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      '[create-taizan-saas] 裁剪后仍有悬空引用（生成出来的项目会带着指向不存在目录的配置）：\n' +
        problems.map((p) => `  · ${p}`).join('\n'),
    )
  }
}

function* walkFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) yield* walkFiles(abs)
    else yield abs
  }
}

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|cjs|mjs|json|prisma|md|ya?ml|conf|sh|scss|css|html|txt|example|toml)$/i

function isTextFile(abs: string): boolean {
  return TEXT_EXT.test(abs) || /(^|[\\/])\.(env\.example|gitignore|npmrc|editorconfig)$/.test(abs)
}

function relOf(root: string, abs: string): string {
  return abs
    .slice(root.length + 1)
    .split(sep)
    .join('/')
}
