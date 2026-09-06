/**
 * `create-taizan-saas` 的 CLI 入口。
 *
 * ```bash
 * pnpm create taizan-saas my-shop                       # 交互式（8 个问题）
 * pnpm create taizan-saas my-shop --preset=full --yes   # 非交互，CI 用
 * pnpm create taizan-saas my-shop --from=/path/to/repo  # 开发模式：用本地仓库的模板
 * ```
 *
 * ## 一次生成的四步
 *
 * 1. **解析**：命令行 → `Answers`（`--yes` 走预设，否则问 8 个问题）。
 * 2. **渲染**：`templates/**` + 上下文 → 目标目录（没选的端不落盘）。
 * 3. **裁剪**：删掉指向未生成端的配置、按标记处理示例模块，然后断言无悬空引用。
 * 4. **接手**：`git init` → `pnpm install` → `schema-sync` → `prisma generate` → 打印验收清单。
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import pc from 'picocolors'

import { buildContext } from './context'
import { prune } from './prune'
import { renderTemplates } from './render'
import { printChecklist, runPostinstall } from './postinstall'
import { askAnswers, defaultAnswers, PRESET_NAMES, PRESETS } from './prompts'
import type { Answers, Bucket, Manifest } from './types'
import { ALL_APPS } from './types'

const HERE = dirname(fileURLToPath(import.meta.url))

interface Cli {
  projectName: string | undefined
  preset: string | undefined
  yes: boolean
  from: string | undefined
  skipInstall: boolean
  skipGit: boolean
  force: boolean
  help: boolean
}

export function parseArgs(argv: readonly string[]): Cli {
  const cli: Cli = {
    projectName: undefined,
    preset: undefined,
    yes: false,
    from: undefined,
    skipInstall: false,
    skipGit: false,
    force: false,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') cli.yes = true
    else if (arg === '--skip-install') cli.skipInstall = true
    else if (arg === '--skip-git') cli.skipGit = true
    else if (arg === '--force') cli.force = true
    else if (arg === '--help' || arg === '-h') cli.help = true
    else if (arg.startsWith('--preset=')) cli.preset = arg.slice('--preset='.length)
    else if (arg.startsWith('--from=')) cli.from = arg.slice('--from='.length)
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}\n用 --help 看用法。`)
    else if (cli.projectName === undefined) cli.projectName = arg
    else throw new Error(`多余的位置参数：${arg}`)
  }
  return cli
}

const HELP = `
${pc.bold('create-taizan-saas')} —— 生成一个多租户 SaaS 项目骨架

  ${pc.cyan('pnpm create taizan-saas <项目名> [选项]')}

选项
  --preset=<名字>   非交互时用哪套端组合：${PRESET_NAMES.join(' | ')}
  --yes, -y         不问问题，全用默认值（配合 --preset）
  --from=<路径>     从本地框架仓库取模板（开发生成器本身时用）
  --skip-install    生成完不跑 pnpm install
  --skip-git        生成完不跑 git init
  --force           目标目录非空时也继续
  --help, -h        看这段

例子
  pnpm create taizan-saas my-shop
  pnpm create taizan-saas my-shop --preset=api-only --yes
`

export async function main(argv: readonly string[]): Promise<number> {
  let cli: Cli
  try {
    cli = parseArgs(argv)
  } catch (e) {
    console.error(pc.red((e as Error).message))
    return 1
  }

  if (cli.help) {
    console.log(HELP)
    return 0
  }

  const templatesDir = resolveTemplatesDir(cli.from)
  const manifestPath = join(templatesDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(
      pc.red(`找不到模板清单：${manifestPath}\n`) +
        '  发布物损坏，或者在框架仓库里还没跑过 `pnpm build:templates`。',
    )
    return 1
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest

  // ── 1. 答案 ──────────────────────────────────────────────────────────
  let answers: Answers
  try {
    answers = await collectAnswers(cli)
  } catch (e) {
    console.error(pc.red((e as Error).message))
    return 1
  }

  const targetDir = resolve(process.cwd(), answers.projectName)
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !cli.force) {
    console.error(
      pc.red(`目标目录已存在且非空：${targetDir}\n`) +
        '  换个项目名，或者加 --force（它不会先清空目录，只是允许往里写）。',
    )
    return 1
  }

  let vars
  try {
    vars = buildContext(answers, manifest.taizanVersion)
  } catch (e) {
    console.error(pc.red((e as Error).message))
    return 1
  }

  // ── 2. 渲染 ──────────────────────────────────────────────────────────
  mkdirSync(targetDir, { recursive: true })
  const keep = (bucket: Bucket): boolean =>
    (ALL_APPS as readonly string[]).includes(bucket) ? vars.apps.includes(bucket as never) : true
  const rendered = renderTemplates(templatesDir, targetDir, vars, manifest, keep)
  console.log(pc.dim(`  渲染 ${rendered.written} 个文件`))

  // ── 3. 裁剪 ──────────────────────────────────────────────────────────
  const report = prune(targetDir, vars)
  if (report.removed.length > 0) {
    console.log(pc.dim(`  裁剪 ${report.removed.length} 处（未选的端与其部署配置）`))
  }

  // ── 4. 接手 ──────────────────────────────────────────────────────────
  const steps = runPostinstall(targetDir, vars, {
    skipInstall: cli.skipInstall,
    skipGit: cli.skipGit,
  })
  printChecklist(targetDir, vars, steps, report.todos)
  return 0
}

async function collectAnswers(cli: Cli): Promise<Answers> {
  if (cli.yes) {
    if (cli.projectName === undefined) {
      throw new Error('--yes 模式下必须给项目名：`pnpm create taizan-saas <项目名> --yes`。')
    }
    const presetName = cli.preset ?? 'full'
    const apps = PRESETS[presetName]
    if (!apps) {
      throw new Error(`未知的 --preset=${presetName}。可选：${PRESET_NAMES.join(' | ')}`)
    }
    return defaultAnswers(cli.projectName, apps)
  }
  const answers = await askAnswers(cli.projectName ?? 'my-saas')
  if (cli.preset !== undefined) {
    const apps = PRESETS[cli.preset]
    if (!apps) throw new Error(`未知的 --preset=${cli.preset}。可选：${PRESET_NAMES.join(' | ')}`)
    return { ...answers, apps: [...apps] }
  }
  return answers
}

/**
 * 找 `templates/`。
 *
 * - `--from=<框架仓库>`：开发生成器时用，指向 `tools/create-taizan-saas/templates`。
 *   接受仓库根、也接受生成器包目录，两种写法都很自然，不该让人记。
 * - 默认：相对本文件（打包后是 `dist/index.js`，模板在 `../templates`）。
 */
function resolveTemplatesDir(from: string | undefined): string {
  if (from !== undefined) {
    const base = isAbsolute(from) ? from : resolve(process.cwd(), from)
    const candidates = [
      join(base, 'tools', 'create-taizan-saas', 'templates'),
      join(base, 'templates'),
      base,
    ]
    for (const c of candidates) {
      if (existsSync(join(c, 'manifest.json'))) return c
    }
    return candidates[0] as string
  }
  return resolve(HERE, '..', 'templates')
}

// tsup 打出来的 dist/index.js 直接被 node 执行；tsx 跑 src/index.ts 时同理。
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts'))

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(pc.red(String(e instanceof Error ? e.stack : e)))
      process.exitCode = 1
    })
}
