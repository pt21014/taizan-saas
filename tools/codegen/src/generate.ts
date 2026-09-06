/**
 * `pnpm gen:module <slug> [--name=中文名]` 的实现：**一次做完蓝图 §7 的七件事**。
 *
 * ## 为什么七件事必须是一条命令
 *
 * 它们分散在七个文件里（schema 片段、隔离注册、权限点、菜单、功能项、审计动作、
 * 队列任务），彼此没有编译期依赖——**漏掉任何一件，代码都能编译、服务都能起来**。
 * 漏掉的后果分别是：这张表不受租户隔离约束（泄漏）、这个权限点点不出来、
 * 菜单不下发、套餐闸门管不到、审计查不到、队列消息没人消费。
 *
 * 靠人记七件事的结果是长期漏第 ②、⑤、⑥ 件（前端看不出来的那三件）。所以这条命令
 * 存在，而且生成完**立刻**建议跑一次 `pnpm test:arch`——那 16 条断言就是七件事的验收。
 *
 * ## 生成什么
 *
 * | # | 扩展点 | 产物 |
 * |---|---|---|
 * | ① | 加表 | 新建 `prisma/schema/10-business/<nn>-<slug>.prisma` |
 * | ② | 注册隔离 | 改 `src/tenancy/tenant-models.ts`（+ package.json 的 verify-schema 清单） |
 * | ③ | 注册权限点 | 新建 `<slug>.permissions.ts` + 改 `src/registry/permissions.ts` |
 * | ④ | 注册菜单 | 新建 `<slug>.menus.ts` + 改 `src/registry/menus.ts` |
 * | ⑤ | 注册功能项 | 改 `src/registry/features.ts` |
 * | ⑥ | 注册审计动作 | 改 `src/registry/audit-actions.ts` |
 * | ⑦ | 注册队列任务 | 新建 `<slug>-sync.handler.ts` + 改 `src/registry/jobs.ts` |
 * | + | 装配 | 改 `src/bootstrap/app.module.ts` |
 * | + | 规则纯函数 | `<slug>.rules.ts` + `<slug>.rules.spec.ts` |
 * | + | e2e 骨架 | `test/<slug>.e2e-spec.ts` |
 * | + | 前端两步 | `apps/admin/src/api/<slug>.ts`、`pages/<slug>/index.tsx`、`routes/component-map.ts` |
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Handlebars from 'handlebars'

import {
  appendToDelimitedScript,
  insertAfterLast,
  insertBeforeFirst,
  type EditOutcome,
} from './edits'
import { deriveNames, type Names } from './naming'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = join(HERE, '..', 'templates')

export interface GenerateOptions {
  /** 项目根（含 `apps/api`）。 */
  root: string
  slug: string
  /** 中文名；不给就用 slug。 */
  name?: string
  /** 只算不写，`--dry-run`。 */
  dryRun?: boolean
}

export interface GenerateResult {
  names: Names
  /** 新建的文件（相对项目根）。 */
  created: string[]
  /** 已存在因而跳过的文件。 */
  skipped: string[]
  /** 就地改写：`[文件, 做了什么, 结果]`。 */
  edits: Array<[string, string, EditOutcome]>
  /** 生成完之后必须跑的验收命令。 */
  verify: string[]
}

/** 渲染上下文 = 命名派生 + 几个位置相关的量。 */
interface Ctx extends Names {
  /** schema 片段文件的基名，例如 `20-order`。 */
  schemaFileBase: string
  /** 菜单排序值：按已有业务菜单往后排。 */
  menuSort: number
}

export function generateModule(opts: GenerateOptions): GenerateResult {
  const names = deriveNames(opts.slug, opts.name ?? opts.slug)
  const api = join(opts.root, 'apps', 'api')
  if (!existsSync(join(api, 'src', 'registry', 'permissions.ts'))) {
    throw new Error(
      `[codegen] ${opts.root} 看起来不是一个 taizan-saas 项目（找不到 apps/api/src/registry/permissions.ts）。\n` +
        '  在项目根目录下跑 `pnpm gen:module <slug>`，或者用 --root=<项目路径> 指定。',
    )
  }

  const businessDir = join(api, 'prisma', 'schema', '10-business')
  const ctx: Ctx = {
    ...names,
    schemaFileBase: `${nextSchemaPrefix(businessDir)}-${names.slug}`,
    menuSort: nextMenuSort(join(api, 'src', 'registry', 'menus.ts')),
  }

  const result: GenerateResult = {
    names,
    created: [],
    skipped: [],
    edits: [],
    verify: buildVerifySteps(opts.root, api, names.snake),
  }

  const moduleDir = join(api, 'src', 'modules', names.slug)
  if (existsSync(moduleDir)) {
    throw new Error(
      `[codegen] 模块目录已存在：apps/api/src/modules/${names.slug}\n` +
        '  换个 slug，或者先把旧目录删掉。生成器不覆盖已有代码——覆盖掉别人写了一周的 service 是不可挽回的。',
    )
  }

  // ── 文件 ────────────────────────────────────────────────────────────
  const files: Array<[template: string, dest: string]> = [
    ['module/schema.prisma.hbs', `apps/api/prisma/schema/10-business/${ctx.schemaFileBase}.prisma`],
    ['module/module.ts.hbs', `apps/api/src/modules/${names.slug}/${names.slug}.module.ts`],
    ['module/controller.ts.hbs', `apps/api/src/modules/${names.slug}/${names.slug}.controller.ts`],
    ['module/service.ts.hbs', `apps/api/src/modules/${names.slug}/${names.slug}.service.ts`],
    ['module/rules.ts.hbs', `apps/api/src/modules/${names.slug}/${names.slug}.rules.ts`],
    ['module/rules.spec.ts.hbs', `apps/api/src/modules/${names.slug}/${names.slug}.rules.spec.ts`],
    [
      'module/permissions.ts.hbs',
      `apps/api/src/modules/${names.slug}/${names.slug}.permissions.ts`,
    ],
    ['module/menus.ts.hbs', `apps/api/src/modules/${names.slug}/${names.slug}.menus.ts`],
    [
      'module/sync-handler.ts.hbs',
      `apps/api/src/modules/${names.slug}/${names.slug}-sync.handler.ts`,
    ],
    ['module/dto.ts.hbs', `apps/api/src/modules/${names.slug}/dto/${names.slug}.dto.ts`],
    ['module/e2e-spec.ts.hbs', `apps/api/test/${names.slug}.e2e-spec.ts`],
  ]
  const hasAdmin = existsSync(join(opts.root, 'apps', 'admin', 'src', 'routes', 'component-map.ts'))
  if (hasAdmin) {
    files.push(
      ['admin/api.ts.hbs', `apps/admin/src/api/${names.slug}.ts`],
      ['admin/page.tsx.hbs', `apps/admin/src/pages/${names.slug}/index.tsx`],
    )
  }

  for (const [tpl, dest] of files) {
    const abs = join(opts.root, dest)
    if (existsSync(abs)) {
      result.skipped.push(dest)
      continue
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, render(tpl, ctx), 'utf8')
    }
    result.created.push(dest)
  }

  if (opts.dryRun) return result

  // ── 七处注册 ────────────────────────────────────────────────────────
  applyRegistrations(opts.root, api, ctx, hasAdmin, result)
  return result
}

function applyRegistrations(
  root: string,
  api: string,
  ctx: Ctx,
  hasAdmin: boolean,
  result: GenerateResult,
): void {
  const rec = (file: string, what: string, outcome: EditOutcome): void => {
    result.edits.push([file, what, outcome])
  }

  // ② 注册隔离
  const tenantModels = join(api, 'src', 'tenancy', 'tenant-models.ts')
  rec(
    'apps/api/src/tenancy/tenant-models.ts',
    '扩展点②：把 ' + ctx.Pascal + ' 登记进 TENANT_MODELS',
    insertAfterLast({
      file: tenantModels,
      after: /^registry\.register\(/,
      text: `registry.register(['${ctx.Pascal}'])`,
      marker: `registry.register(['${ctx.Pascal}'])`,
      what: '扩展点② 注册隔离',
    }),
  )
  rec(
    'apps/api/src/tenancy/tenant-models.ts',
    '扩展点②：软删清单',
    insertBeforeFirst({
      file: tenantModels,
      before: /^\]\)$/,
      text: `  '${ctx.Pascal}',`,
      marker: `  '${ctx.Pascal}',`,
      what: '扩展点② 软删清单 SOFT_DELETE_MODELS',
    }),
  )
  rec(
    'apps/api/package.json',
    '扩展点②：verify-schema 的 --registered 清单',
    appendToDelimitedScript(
      join(api, 'package.json'),
      'taizan:verify-schema',
      '--registered=',
      ctx.Pascal,
    ),
  )

  // ③ 注册权限点
  const permissions = join(api, 'src', 'registry', 'permissions.ts')
  rec(
    'apps/api/src/registry/permissions.ts',
    '扩展点③：import 权限点',
    insertAfterLast({
      file: permissions,
      after: /^import .* from '\.\.\/modules\//,
      text: `import { ${ctx.CONST}_PERMISSIONS } from '../modules/${ctx.slug}/${ctx.slug}.permissions'`,
      marker: `${ctx.CONST}_PERMISSIONS } from '../modules/${ctx.slug}/`,
      what: '扩展点③ 权限点导入',
    }),
  )
  rec(
    'apps/api/src/registry/permissions.ts',
    '扩展点③：汇总进 PERMISSIONS',
    insertAfterLast({
      file: permissions,
      after: /^ {2}\.\.\.[A-Z0-9_]+_PERMISSIONS,$/,
      text: `  ...${ctx.CONST}_PERMISSIONS,`,
      marker: `  ...${ctx.CONST}_PERMISSIONS,`,
      what: '扩展点③ 汇总',
    }),
  )
  rec(
    'apps/api/src/registry/permissions.ts',
    '扩展点③：撞名检查的来源表',
    insertAfterLast({
      file: permissions,
      after: /^ {4}\['[^']+', [A-Z0-9_]+_PERMISSIONS\],$/,
      text: `    ['${ctx.slug}', ${ctx.CONST}_PERMISSIONS],`,
      marker: `['${ctx.slug}', ${ctx.CONST}_PERMISSIONS]`,
      what: '扩展点③ 撞名检查来源表',
    }),
  )

  // ④ 注册菜单
  const menus = join(api, 'src', 'registry', 'menus.ts')
  rec(
    'apps/api/src/registry/menus.ts',
    '扩展点④：import 菜单',
    insertAfterLast({
      file: menus,
      after: /^import .* from '\.\.\/modules\//,
      text: `import { ${ctx.CONST}_MENUS } from '../modules/${ctx.slug}/${ctx.slug}.menus'`,
      marker: `${ctx.CONST}_MENUS } from '../modules/${ctx.slug}/`,
      what: '扩展点④ 菜单导入',
    }),
  )
  rec(
    'apps/api/src/registry/menus.ts',
    '扩展点④：汇总进 ADMIN_MENUS',
    insertAfterLast({
      file: menus,
      after: /^ {2}\.\.\.ADMIN_FRAMEWORK_MENUS,$/,
      text: `  ...${ctx.CONST}_MENUS,`,
      marker: `  ...${ctx.CONST}_MENUS,`,
      what: '扩展点④ 汇总',
    }),
  )

  // ⑤ 注册套餐功能项
  rec(
    'apps/api/src/registry/features.ts',
    '扩展点⑤：套餐功能项（只拦写不拦读）',
    insertBeforeFirst({
      file: join(api, 'src', 'registry', 'features.ts'),
      before: /^\]$/,
      text: [
        '  {',
        `    key: '${ctx.slug}',`,
        `    name: '${ctx.name}模块',`,
        `    // 只拦写不拦读：套餐没含这个模块时，已有数据仍然看得见（不然商家会以为数据丢了），`,
        '    // 只是新增/改/删被拦。这是「降级」而不是「删功能」。',
        '    writeOnly: true,',
        `    pathPrefixes: ['/api/admin/${ctx.slug}'],`,
        '  },',
      ].join('\n'),
      marker: `key: '${ctx.slug}',`,
      what: '扩展点⑤ 套餐功能项',
    }),
  )

  // ⑥ 注册审计动作
  rec(
    'apps/api/src/registry/audit-actions.ts',
    '扩展点⑥：三个审计动作',
    insertAfterLast({
      file: join(api, 'src', 'registry', 'audit-actions.ts'),
      after: /^export const APP_AUDIT_ACTIONS = defineAuditActions\(\{$/,
      text: [
        `  /** 新建${ctx.name}。 */`,
        `  ${ctx.CONST}_CREATE: '${ctx.slug}.create',`,
        `  /** 修改${ctx.name}。 */`,
        `  ${ctx.CONST}_UPDATE: '${ctx.slug}.update',`,
        `  /** 删除（软删）${ctx.name}。 */`,
        `  ${ctx.CONST}_DELETE: '${ctx.slug}.delete',`,
        '',
      ].join('\n'),
      marker: `${ctx.CONST}_CREATE: '${ctx.slug}.create',`,
      what: '扩展点⑥ 审计动作',
    }),
  )

  // ⑦ 注册队列任务
  const jobs = join(api, 'src', 'registry', 'jobs.ts')
  rec(
    'apps/api/src/registry/jobs.ts',
    '扩展点⑦：import 任务名常量',
    insertAfterLast({
      file: jobs,
      after: /^import .* from '\.\.\/modules\//,
      text: `import { ${ctx.CONST}_SYNC_JOB_NAME } from '../modules/${ctx.slug}/${ctx.slug}-sync.handler'`,
      marker: `${ctx.CONST}_SYNC_JOB_NAME } from '../modules/${ctx.slug}/`,
      what: '扩展点⑦ 任务名导入',
    }),
  )
  rec(
    'apps/api/src/registry/jobs.ts',
    '扩展点⑦：JOBS 注册项',
    insertBeforeFirst({
      file: jobs,
      before: /^\]$/,
      text: [
        '  {',
        `    name: ${ctx.CONST}_SYNC_JOB_NAME,`,
        `    queue: ${ctx.CONST}_SYNC_JOB_NAME,`,
        `    title: '${ctx.name}同步',`,
        '  },',
      ].join('\n'),
      marker: `name: ${ctx.CONST}_SYNC_JOB_NAME,`,
      what: '扩展点⑦ JOBS 注册',
    }),
  )

  // 装配
  const appModule = join(api, 'src', 'bootstrap', 'app.module.ts')
  rec(
    'apps/api/src/bootstrap/app.module.ts',
    '装配：import 模块',
    insertAfterLast({
      file: appModule,
      after: /^import .* from '\.\.\/modules\//,
      text: `import { ${ctx.Pascal}Module } from '../modules/${ctx.slug}/${ctx.slug}.module'`,
      marker: `${ctx.Pascal}Module } from '../modules/${ctx.slug}/`,
      what: '装配 import',
    }),
  )
  rec(
    'apps/api/src/bootstrap/app.module.ts',
    '装配：AppModule.imports',
    insertAfterLast({
      file: appModule,
      after: /^ {4}[A-Za-z0-9_]+Module,$/,
      text: `    ${ctx.Pascal}Module,`,
      marker: `    ${ctx.Pascal}Module,`,
      what: '装配 imports',
    }),
  )

  // 前端第一步：component-map
  if (hasAdmin) {
    rec(
      'apps/admin/src/routes/component-map.ts',
      '前端：componentKey → 页面组件',
      insertAfterLast({
        file: join(root, 'apps', 'admin', 'src', 'routes', 'component-map.ts'),
        after: /^ {2}[A-Za-z0-9_]+: lazy\(/,
        text: `  ${ctx.componentKey}: lazy(() => import('../pages/${ctx.slug}')),`,
        marker: `  ${ctx.componentKey}: lazy(`,
        what: '前端 component-map',
      }),
    )
  }
}

/**
 * 生成之后**必须**跑的几条命令。
 *
 * 顺序有依赖：没 `prisma generate` 就没有新 model 的类型，`pnpm build` 必然红；
 * 没 `sync-menus` 就没有新菜单的 JSON 快照，`apps/admin` 的 spec 7 会报
 * 「component-map 里登记了但没有菜单引用」——那条报错听起来像是生成器插错了，
 * 其实只是快照没更新。把它写进清单，比让人去猜便宜得多。
 */
function buildVerifySteps(root: string, api: string, snake: string): string[] {
  const apiName = packageNameOf(join(api, 'package.json')) ?? 'api'
  const steps = [
    'pnpm taizan:schema-sync && pnpm prisma:generate',
    `pnpm -F ${apiName} exec prisma migrate dev --name add_${snake}`,
  ]
  const adminName = packageNameOf(join(root, 'apps', 'admin', 'package.json'))
  if (adminName !== null) steps.push(`pnpm -F ${adminName} sync-menus`)
  steps.push('pnpm test:arch', 'pnpm lint && pnpm typecheck && pnpm test')
  return steps
}

function packageNameOf(pkgPath: string): string | null {
  if (!existsSync(pkgPath)) return null
  const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
  return raw.name ?? null
}

/** 下一个 schema 片段的数字前缀：已有最大值 + 10，两位补零。 */
function nextSchemaPrefix(businessDir: string): string {
  let max = 0
  if (existsSync(businessDir)) {
    for (const f of readdirSync(businessDir)) {
      const m = /^(\d+)-/.exec(f)
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  const next = max === 0 ? 10 : max + 10
  return String(next).padStart(2, '0')
}

/** 下一个业务菜单的 sort：已有最大值 + 10，从 20 起（框架菜单占了 10 以内）。 */
function nextMenuSort(menusFile: string): number {
  if (!existsSync(menusFile)) return 20
  const text = readFileSync(menusFile, 'utf8')
  const sorts = [...text.matchAll(/^\s*sort: (\d+),$/gm)].map((m) => Number(m[1]))
  const max = sorts.length > 0 ? Math.max(...sorts) : 10
  return Math.max(20, max + 10)
}

function render(templateRel: string, ctx: Ctx): string {
  const src = readFileSync(join(TEMPLATES, templateRel), 'utf8')
  return Handlebars.compile(src, { noEscape: true })(ctx)
}
