/**
 * 快照期的**改写规则表**：把 `apps/**`、`deploy/**`、根配置里的品牌 / 项目名 / 端口 /
 * 域名 / 示例业务域，逐条换成 `.hbs` 变量。
 *
 * ## 为什么规则要集中成一张表，而不是散在 build-templates.ts 里
 *
 * 模板不是手工维护的副本，是**每次 `pnpm build:templates` 从 apps/ 现场快照**出来的
 * （别的 agent 还在改 `apps/admin`、`packages/*`，手工副本第二天就过期）。既然如此，
 * 「哪些字面量是可替换点」这件事就是这个包**唯一的领域知识**，值得单独一个文件、
 * 单独一组单测。规则表变了 → `--check` 会红 → 有人必须重新看一眼这张表。
 *
 * ## 三个阶段，顺序不能换
 *
 * 1. **protect**：先把「长得像但绝不能换」的字面量替换成哨兵。典型是
 *    `@taizan/contracts`（框架包，生成项目要从 npm 装它，名字不能改）与
 *    `taizan-schema-sync`（`@taizan/prisma-base` 提供的 bin，改了就调不到）。
 *    不先保护就必须给每条规则写一串负向断言，那是不可维护的。
 * 2. **rewrite**：按 `TEXT_RULES` 顺序做替换。顺序敏感：`taizan-saas` 必须排在
 *    `taizan-` 前面，`钛赞 SaaS` 必须排在 `钛赞` 前面——长的先匹配。
 * 3. **restore**：哨兵换回原字面量。
 *
 * @packageDocumentation
 */

import { ALL_APPS } from './types'

/** 三个共享配置包：它们随生成项目一起走（`tools/` 目录），所以要跟着换 scope。 */
export const TOOL_CONFIG_PACKAGES = [
  'tsconfig',
  'eslint-config',
  'prettier-config',
  // codegen 也随项目走：`pnpm gen:module <slug>` 要能在**生成出来的项目里**跑，
  // 而不是只在框架仓库里跑（蓝图 §7 的七件事是业务项目每天都要做的事）。
  'codegen',
] as const

/**
 * 会被换成 `{{scope}}/…` 的包名后缀 = 七个端 + 三个配置包。
 *
 * 其余 `@taizan/*` 一律是**框架包**：生成项目从 npm 装，名字必须原样保留。
 * 判据是「这个包的源码会不会被拷进生成项目」——会，就换 scope；不会，就保留。
 */
export const SCOPED_PACKAGE_SUFFIXES: readonly string[] = [...ALL_APPS, ...TOOL_CONFIG_PACKAGES]

/**
 * 绝不改写的字面量（protect 阶段）。
 *
 * - `create-taizan-saas`：生成器自己的包名，生成项目的 README 里会提到它；
 * - `taizan-schema-sync` / `taizan-verify-schema`：`@taizan/prisma-base` 的 bin 名；
 * - `taizan:schema-sync` 等：`apps/api/package.json` 的脚本名。生成后的
 *   `postinstall` 与 `deploy/scripts/migrate.sh` 都按名字调它们，改名等于全线断掉。
 */
export const PROTECTED_LITERALS: readonly string[] = [
  'create-taizan-saas',
  'taizan-schema-sync',
  'taizan-verify-schema',
  'taizan:schema-sync',
  'taizan:schema-check',
  'taizan:verify-schema',
  'taizan:env-example',
]

/**
 * `{{` 的哨兵。取值用 NUL 包住——源码里不可能出现 U+0000，所以不会与真实内容撞。
 */
const BRACE_SENTINEL = '\u0000B\u0000'

/** 一条文本改写规则。 */
export interface TextRule {
  /** 规则编号，报告与单测里引用它。 */
  id: string
  /** 匹配。一律带 `g`。 */
  find: RegExp
  /** 替换串（可用 `$1`）。 */
  replace: string
  /** 为什么这是个可替换点。 */
  why: string
  /**
   * 限定生效路径（相对仓库根的 POSIX 路径前缀）。不给 = 全量文本文件。
   *
   * 端口这类规则必须限定：`3000` 在任何一段散文里都可能出现，全量替换会把
   * 「压测 3000 QPS」也改掉。
   */
  only?: readonly string[]
  /** 只在 `@taizan-example-*` 标记区间内生效（示例业务的中文名走这条）。 */
  exampleRegionOnly?: boolean
}

/** 只属于示例业务模块、整份文件都可以做业务域替换的路径。 */
export const EXAMPLE_FILE_PREFIXES: readonly string[] = [
  'apps/api/src/modules/example-goods/',
  'apps/api/src/modules/client/goods/',
  'apps/api/prisma/schema/10-business/',
  'apps/admin/src/api/goods.ts',
  'apps/admin/src/pages/goods/',
  'apps/admin/e2e/owner-goods-crud.spec.ts',
  'apps/client/src/services/goods.ts',
  'apps/client/src/pages/goods/',
  'apps/app-client/app/goods/',
  'apps/app-merchant/app/goods/',
]

/** 端口出现在哪些文件里（`only` 用）。 */
const PORT_FILES = {
  api: [
    'apps/api/.env.example',
    'apps/admin/vite.config.ts',
    'apps/platform/vite.config.ts',
    'apps/site/vite.config.ts',
    'apps/admin/.env.example',
    'apps/site/.env.example',
    'apps/platform/.env.example',
    'apps/client/.env.example',
    'deploy/nginx/',
    'deploy/docker/',
    'deploy/pm2/',
  ],
  admin: ['apps/admin/vite.config.ts', 'apps/site/src/config/BRAND.ts'],
  platform: ['apps/platform/vite.config.ts', 'apps/platform/playwright.config.ts'],
  site: ['apps/site/vite.config.ts', 'apps/site/playwright.config.ts'],
} as const

/**
 * 改写规则表（顺序敏感，见文件头「三个阶段」）。
 *
 * | # | 匹配 | 替换 |
 * |---|---|---|
 * | S1 | `@taizan/{七个端,三个配置包}` | `{{scope}}/…` |
 * | P1 | `TAIZAN_`（环境变量前缀） | `{{projectConst}}_` |
 * | P2 | `taizan-saas` | `{{projectName}}` |
 * | P3 | `taizan_` | `{{projectSlug}}_` |
 * | P4 | `taizan-` | `{{projectName}}-` |
 * | P5 | `taizan:`（Redis key 前缀） | `{{projectSlug}}:` |
 * | P6 | 余下的 `taizan` | `{{projectSlug}}` |
 * | B1 | `钛赞 SaaS` | `{{productName}}` |
 * | B2 | `钛赞` | `{{productName}}` |
 * | D1 | `example.com` | `{{rootDomain}}` |
 * | N1..N5 | 端口 3000/5173/5175/5176/10086 | `{{apiPort}}` 等 |
 * | G1 | `GoodsStatus` 等标识符里的 `Goods` | `{{DomainPascal}}` |
 * | G2 | `GOODS` | `{{DOMAIN_UPPER}}` |
 * | G3 | `goods` | `{{domainSlug}}` |
 * | G4 | `商品`（仅示例文件与标记区间内） | `{{domainName}}` |
 */
export const TEXT_RULES: readonly TextRule[] = [
  {
    id: 'S1',
    find: new RegExp(`@taizan/(${SCOPED_PACKAGE_SUFFIXES.join('|')})(?![\\w-])`, 'g'),
    replace: '{{scope}}/$1',
    why: '七个端与三个共享配置包的源码会被拷进生成项目，包名要跟着用户的 scope 走；其余 @taizan/* 是从 npm 装的框架包，名字不能改。',
  },
  {
    id: 'P1',
    find: /TAIZAN_/g,
    replace: '{{projectConst}}_',
    why: '部署脚本的环境变量前缀（TAIZAN_APP_DIR / TAIZAN_IMAGE_TAG）。',
  },
  {
    id: 'P2',
    find: /taizan-saas/g,
    replace: '{{projectName}}',
    why: '仓库名 / 发布目录名 / docker compose project name。必须排在 P4 前面。',
  },
  {
    id: 'P3',
    find: /taizan_/g,
    replace: '{{projectSlug}}_',
    why: '数据库名与库用户口令（taizan_dev / taizan_ci_root）。',
  },
  {
    id: 'P4',
    find: /taizan-/g,
    replace: '{{projectName}}-',
    why: 'pm2 进程名（taizan-api）、容器名（taizan-mysql-dev）、发布包名（taizan-release-*）。',
  },
  {
    id: 'P5',
    find: /taizan:/g,
    replace: '{{projectSlug}}:',
    why: 'Redis key 前缀（taizan:lock:cron:*）。npm 脚本名 taizan:schema-sync 已在 protect 阶段保住。',
  },
  {
    id: 'P6',
    find: /taizan/g,
    replace: '{{projectSlug}}',
    why: '余下的裸 taizan：数据库用户名、DATABASE_URL 示例串。',
  },
  {
    id: 'B1',
    find: /钛赞 SaaS/g,
    replace: '{{productName}}',
    why: 'apps/site/src/config/BRAND.ts 的产品全称——品牌位单一真源。必须排在 B2 前面。',
  },
  {
    id: 'B2',
    find: /钛赞/g,
    replace: '{{productName}}',
    why: '品牌简称与散落在注释里的品牌字样。',
  },
  {
    id: 'D1',
    find: /example\.com/g,
    replace: '{{rootDomain}}',
    why: 'nginx 四站点的 server_name / 证书路径 / 日志路径。',
    only: ['deploy/', 'apps/'],
  },
  {
    id: 'N1',
    find: /\b3000\b/g,
    replace: '{{apiPort}}',
    why: 'api 监听端口，同时是三个前端 vite 代理的 target。',
    only: PORT_FILES.api,
  },
  {
    id: 'N2',
    find: /\b5173\b/g,
    replace: '{{adminPort}}',
    why: 'apps/admin 的 dev server 端口，也是 BRAND.adminUrl 的本地默认值。',
    only: PORT_FILES.admin,
  },
  {
    id: 'N3',
    find: /\b5175\b/g,
    replace: '{{platformPort}}',
    why: 'apps/platform 的 dev / preview 端口。',
    only: PORT_FILES.platform,
  },
  {
    id: 'N4',
    find: /\b5176\b/g,
    replace: '{{sitePort}}',
    why: 'apps/site 的 dev 端口。',
    only: PORT_FILES.site,
  },
  {
    id: 'N5',
    find: /\b10086\b/g,
    replace: '{{clientPort}}',
    why: 'apps/client（Taro H5）的 dev 端口。',
    only: ['apps/client/'],
  },
  {
    id: 'G1',
    find: /Goods/g,
    replace: '{{DomainPascal}}',
    why: '示例业务的 model / 类 / 组件名（Goods、GoodsSku、GoodsListPage、GOODS 之外的 PascalCase）。',
  },
  {
    id: 'G2',
    find: /GOODS/g,
    replace: '{{DOMAIN_UPPER}}',
    why: '示例业务的常量名（GOODS_PERMISSIONS / GOODS_SYNC_JOB_NAME）。必须排在 G3 前面。',
  },
  {
    id: 'G3',
    find: /goods/g,
    replace: '{{domainSlug}}',
    why: '示例业务的目录名、路由段、权限点前缀、任务名（example-goods、/api/admin/goods、goods:list、goods.sync）。',
  },
  {
    id: 'G4',
    find: /商品/g,
    replace: '{{domainName}}',
    why: '示例业务的中文名。只在示例文件与 @taizan-example 标记区间内替换——框架自己的注释里也提到「商品」，那些不是可替换点。',
    exampleRegionOnly: true,
  },
]

/** 标记注释：裁剪示例模块时按它删行。语法按文件类型选（见 `markerFor`）。 */
export const EXAMPLE_MARKER = 'taizan-example'

/** 标记注释：某个端专属的行，裁剪该端时删。 */
export const APP_MARKER_PREFIX = 'taizan-app:'

/** 按扩展名给出行注释前缀；返回 `null` 表示这种文件不支持标记。 */
export function commentPrefixFor(filePath: string): string | null {
  const lower = filePath.toLowerCase()
  if (/\.(ts|tsx|js|jsx|cjs|mjs|cts|mts|prisma|scss|css)$/.test(lower)) return '//'
  if (/\.(ya?ml|conf|sh|toml|env|example|gitignore|npmrc|editorconfig)$/.test(lower)) return '#'
  if (lower.endsWith('.md') || lower.endsWith('.html')) return '<!--'
  return null
}

/**
 * 保护 → 改写 → 还原。
 *
 * **按行调用**：`build-templates.ts` 逐行喂，因为「这一行在不在示例标记区间里」是
 * 逐行的判断，而所有规则都不跨行（`@taizan/xxx`、端口、`Goods` 都在一行之内）。
 * 逐行还有一个好处：插标记注释时不用再算字符偏移。
 *
 * @param repoRelPath 相对仓库根的 POSIX 路径，决定 `only` 限定的规则生不生效
 * @param text 一行（或整份文件，单测里这么用）
 * @param exampleRegion 这段文本是否属于示例业务（决定 G4「商品」这条规则生不生效）
 */
export function applyTextRules(
  repoRelPath: string,
  text: string,
  exampleRegion = false,
): { output: string; applied: string[] } {
  const applied = new Set<string>()
  /** 本次调用的框架包名哨兵表（不能是模块级，否则并发/嵌套调用会串号）。 */
  const frameworkSentinels: string[] = []

  // ── 1. protect ──────────────────────────────────────────────────────────
  // 哨兵用 \u0000 包起来：源码里不可能出现 NUL，所以不会与真实内容撞。
  let work = text
  // 源码里原本就有的 `{{`（例如 docs 里引用生成器变量的那几行）先藏起来，
  // 还原时补一个反斜杠 —— Handlebars 用 `\{{` 表示「输出字面量 {{」。
  // 不藏的话它会被当成模板表达式求值，渲染出空字符串。
  work = work.split('{{').join('\u0000B\u0000')
  PROTECTED_LITERALS.forEach((literal, i) => {
    work = work.split(literal).join(`\u0000P${i}\u0000`)
  })
  // 框架包名（@taizan/xxx 中不在 SCOPED_PACKAGE_SUFFIXES 里的）整体保护。
  work = work.replace(/@taizan\/[a-z0-9-]+/g, (m) => {
    const suffix = m.slice('@taizan/'.length)
    if (SCOPED_PACKAGE_SUFFIXES.includes(suffix)) return m
    const idx = frameworkSentinels.indexOf(m)
    if (idx === -1) frameworkSentinels.push(m)
    return `\u0000F${frameworkSentinels.indexOf(m)}\u0000`
  })

  // ── 2. rewrite ──────────────────────────────────────────────────────────
  for (const rule of TEXT_RULES) {
    if (rule.only && !rule.only.some((p) => repoRelPath.startsWith(p))) continue
    if (rule.exampleRegionOnly && !exampleRegion && !isExampleFile(repoRelPath)) continue
    const next = work.replace(rule.find, rule.replace)
    if (next !== work) applied.add(rule.id)
    work = next
  }

  // ── 3. restore ──────────────────────────────────────────────────────────
  frameworkSentinels.forEach((name, i) => {
    work = work.split(`\u0000F${i}\u0000`).join(name)
  })
  PROTECTED_LITERALS.forEach((literal, i) => {
    work = work.split(`\u0000P${i}\u0000`).join(literal)
  })

  work = work.split(BRACE_SENTINEL).join(String.raw`\{{`)

  return { output: separateAdjacentBraces(work), applied: [...applied] }
}

/**
 * 把「源码里的 `{` 紧挨着我们插入的 `{{变量}}`」这种组合分开一个空格。
 *
 * 典型现场：源码里有 `` `状态只能是 ${GOODS_STATUSES.join(' / ')}` ``，规则 G2 把
 * `GOODS` 换成 `{{DOMAIN_UPPER}}` 之后就成了 `${` + `{{DOMAIN_UPPER}}`。
 * Handlebars 看到开头的三个左花括号会按**不转义输出**去解析，然后找不到配对的三个
 * 右花括号，直接报 parse error——而这个错发生在**用户生成项目的时候**，不是在快照的时候。
 *
 * 另一头同理：`src/modules/{admin,client,example-goods}/**` 会变成
 * `...example-{{domainSlug}}` 后面紧跟一个 `}`。
 *
 * 只碰**我们自己插进去的**那些 `{{变量}}`：不做无差别的三右花括号替换，
 * 那会把源码里每一处嵌套代码块的收尾都改掉。
 */
function separateAdjacentBraces(text: string): string {
  return text.replace(
    /(\{?)(\{\{[A-Za-z_][A-Za-z0-9_]*\}\})(\}?)/g,
    (_m, pre: string, variable: string, post: string) =>
      (pre === '' ? '' : pre + ' ') + variable + (post === '' ? '' : ' ' + post),
  )
}

/** 整份文件都属于示例业务（路径在 `EXAMPLE_FILE_PREFIXES` 里）。 */
export function isExampleFile(repoRelPath: string): boolean {
  return EXAMPLE_FILE_PREFIXES.some((p) => repoRelPath.startsWith(p))
}
