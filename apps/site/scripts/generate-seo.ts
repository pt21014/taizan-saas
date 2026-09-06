/**
 * `NAV`（单一路由真源） → `dist/robots.txt` + `dist/sitemap.xml`。
 *
 * 不手写 sitemap 是因为它会跟导航表脱节：加一个页面、忘了同步 sitemap，
 * 搜索引擎收录的永远是少一页的旧列表。这里直接读 `src/config/NAV.ts` 的
 * `ALL_PAGES`，11 个路由（含服务条款/隐私政策/注册）一次生成。
 *
 * **只写 `dist/`，不写 `public/`**（T4-5 之后的修复）：曾经这两个文件生成到
 * `public/`（受版本管理），`<lastmod>` 又取「今天的日期」——同一次提交只要隔天
 * 重新构建一次，`public/sitemap.xml` 就会跟仓库里的版本产生 diff，直接把
 * `pnpm build:templates:check`（快照来自 `apps/` 现场）冲红，且红的原因跟改了
 * 什么代码毫无关系。这份脚本因此必须**在 `vite build` 之后**跑（见
 * `package.json` 的 `build` 脚本顺序），直接把两个文件写进已经存在的 `dist/`——
 * 不再经过受版本管理的 `public/`，构建产物里天然就有，不需要 `vite` 的
 * `publicDir` 拷贝这一步。
 *
 * `<lastmod>` 的确定性同理：不能再用「今天」。取值顺序：
 *   1. `SITE_LASTMOD` 环境变量（部署流水线可以钉死成发布时间）；
 *   2. `git log -1 --format=%cI`（最近一次提交时间——同一个提交多次构建结果一致）；
 *   3. 都拿不到时（本机没装 git、或仓库还没有任何提交）回退到一个固定值，
 *      保证构建产物在没有外部输入的情况下依然是确定性的，而不是直接失败——
 *      这一行的取值写错只影响搜索引擎收录，不该让构建本身失败。
 *
 * `SITE_ORIGIN` 环境变量给生产部署用（真实域名）；本地/CI 没配时退回一个占位域名——
 * sitemap 里的绝对地址即使写错也不影响构建产物存在与否，只影响搜索引擎收录，
 * 不该让这个脚本在没配域名的开发机上直接失败。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_PAGES } from '../src/config/NAV'

const here = dirname(fileURLToPath(import.meta.url))
const siteDir = resolve(here, '..')
const distDir = resolve(siteDir, 'dist')

const origin = (process.env.SITE_ORIGIN ?? 'https://example.com').replace(/\/$/, '')

/** 固定回退值：没有 git、也没配 `SITE_LASTMOD` 时用它，保证构建产物确定。 */
const FALLBACK_LASTMOD = '2024-01-01'

function resolveLastmod(): string {
  const fromEnv = process.env.SITE_LASTMOD
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim().slice(0, 10)
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI'], {
      cwd: siteDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    if (out !== '') return out.slice(0, 10)
  } catch {
    // 没装 git，或仓库还没有任何 commit（`git log` 报错）——落到固定回退值。
  }
  return FALLBACK_LASTMOD
}

function buildRobots(): string {
  return [
    '# 本文件由 apps/site/scripts/generate-seo.ts 生成。',
    'User-agent: *',
    'Allow: /',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}

function buildSitemap(lastmod: string): string {
  const urls = ALL_PAGES.map((page) => {
    const loc = `${origin}${page.to === '/' ? '/' : page.to}`
    // 首页与注册页是转化路径上最重要的两个入口，优先级给高一点，其余页面一律 0.6。
    const priority = page.to === '/' || page.to === '/signup' ? '0.9' : '0.6'
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      `    <priority>${priority}</priority>`,
      '  </url>',
    ].join('\n')
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}

const lastmod = resolveLastmod()

// `vite build`（`emptyOutDir: true`）已经在这个脚本之前跑过，`dist/` 应该已经存在；
// 这里仍然 `mkdirSync(..., { recursive: true })` 兜底，避免有人单独调这个脚本时因为
// 目录不存在而报错——写文件本身不该对调用顺序这么敏感。
mkdirSync(distDir, { recursive: true })
writeFileSync(resolve(distDir, 'robots.txt'), buildRobots(), 'utf8')
writeFileSync(resolve(distDir, 'sitemap.xml'), buildSitemap(lastmod), 'utf8')
process.stdout.write(
  `[seo] 写入 ${ALL_PAGES.length + 1} 个条目到 dist/robots.txt / dist/sitemap.xml（lastmod=${lastmod}）\n`,
)
