/**
 * 渲染：`templates/**` + 上下文 → 目标目录。
 *
 * 规则只有三条，刻意保持到「读一遍就能复述」：
 *
 * 1. `.hbs` 后缀 = 需要渲染，渲染完去掉后缀；
 * 2. 路径本身也过一遍 Handlebars（`apps/api/src/modules/example-{{domainSlug}}/` 这种
 *    目录名靠它）；
 * 3. 其余原样拷贝，二进制走 Buffer。
 *
 * **`noEscape: true`**：模板是源码不是 HTML。默认的 HTML 转义会把 `&&` 变成 `&amp;&amp;`、
 * 把 `'` 变成 `&#x27;`——生成出来的项目连 parse 都过不了，而症状出现在离原因很远的地方。
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import Handlebars from 'handlebars'

import type { Manifest, ManifestEntry, TemplateVars } from './types'

/** 渲染一段模板文本。 */
export function renderText(source: string, vars: TemplateVars): string {
  return Handlebars.compile(source, { noEscape: true, strict: false })(vars)
}

/**
 * `_gitignore` → `.gitignore`。
 *
 * npm 发布时会把包里的 `.gitignore` 吃掉（历史包袱，改不了），所以模板里存成 `_gitignore`，
 * 落盘时改回来。同理还有 `_npmrc`——本仓库暂时没有，先留着这条规则的位置。
 */
const DOTFILE_PREFIX_MAP: ReadonlyArray<readonly [string, string]> = [
  ['_gitignore', '.gitignore'],
  ['_npmrc', '.npmrc'],
]

/** 把一条 manifest 记录的模板路径变成目标项目里的真实路径。 */
export function targetPathOf(entry: ManifestEntry, vars: TemplateVars): string {
  let p = entry.path
  // 只有**要渲染**的才去掉 `.hbs`。`tools/codegen/templates/**.hbs` 是原样带走的
  // codegen 模板，后缀必须留着——生成项目里的 `pnpm gen:module` 还要读它们。
  if (entry.render && p.endsWith('.hbs')) p = p.slice(0, -'.hbs'.length)
  p = renderText(p, vars)
  const segments = p.split('/')
  const last = segments[segments.length - 1] as string
  for (const [from, to] of DOTFILE_PREFIX_MAP) {
    if (last === from) segments[segments.length - 1] = to
  }
  return segments.join('/')
}

export interface RenderResult {
  /** 落盘的文件数。 */
  written: number
  /** 相对目标目录的 POSIX 路径清单，供 `prune.ts` 与单测使用。 */
  files: string[]
}

/**
 * 把整份模板渲染到 `targetDir`。
 *
 * `bucketFilter` 在渲染**之前**过滤：没选的端根本不落盘，而不是落盘再删。
 * 少写几千个文件对 Windows 上的机械硬盘不是可忽略的差别，而且「没生成过」
 * 比「生成了又删」更容易在出问题时讲清楚。
 */
export function renderTemplates(
  templatesDir: string,
  targetDir: string,
  vars: TemplateVars,
  manifest: Manifest,
  keepBucket: (bucket: ManifestEntry['bucket']) => boolean,
): RenderResult {
  const files: string[] = []
  for (const entry of manifest.files) {
    if (!keepBucket(entry.bucket)) continue
    const src = join(templatesDir, entry.path.split('/').join(sep))
    if (!existsSync(src)) {
      throw new Error(
        `[create-taizan-saas] 模板文件缺失：${entry.path}\n` +
          '  manifest.json 与 templates/ 对不上。发布物损坏，或者本地跑了一半的 build:templates。',
      )
    }
    const rel = targetPathOf(entry, vars)
    const dest = join(targetDir, rel.split('/').join(sep))
    mkdirSync(dirname(dest), { recursive: true })
    if (entry.binary) {
      writeFileSync(dest, readFileSync(src))
    } else {
      const text = readFileSync(src, 'utf8')
      writeFileSync(dest, entry.render ? renderText(text, vars) : text, 'utf8')
    }
    files.push(rel)
  }
  return { written: files.length, files }
}
