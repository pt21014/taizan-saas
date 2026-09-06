/**
 * 生成器的单测：**不装依赖、不联网**，全部在临时目录里做文件操作。
 *
 * 分四组，对应生成器真正会出错的四个地方：
 *
 * 1. **改写规则**：品牌/项目名/端口/业务域有没有真的变成 `{{变量}}`，
 *    以及**不该改的有没有被改**（框架包名、`taizan-schema-sync` 这个 bin）。
 * 2. **渲染**：`.hbs` 去后缀、路径里的变量、`_gitignore` → `.gitignore`。
 * 3. **裁剪**：删掉 admin 之后 turbo/workspace/nginx/根 package.json 里没有悬空引用。
 * 4. **manifest**：清单与磁盘一致（这是 `--check` 的地基）。
 *
 * 真正「装依赖 + 编译 + 跑测试」那一层在 `pnpm create:demo`，不在这里——
 * 那一层要几分钟，放进单测会让人不敢跑单测。
 *
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { buildContext } from '../src/context'
import { prune } from '../src/prune'
import { renderTemplates, renderText, targetPathOf } from '../src/render'
import { applyTextRules, PROTECTED_LITERALS } from '../src/rewrite'
import { defaultAnswers, PRESETS } from '../src/prompts'
import type { AppName, Bucket, Manifest } from '../src/types'
import { ALL_APPS } from '../src/types'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = join(PKG_ROOT, 'templates')
const MANIFEST: Manifest = JSON.parse(readFileSync(join(TEMPLATES, 'manifest.json'), 'utf8'))

const tmpDirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'taizan-gen-test-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

/** 一份典型答案：把每个变量都换成与默认值不同的值，替换漏了立刻看得出来。 */
function vars(overrides: Partial<ReturnType<typeof defaultAnswers>> = {}) {
  return buildContext(
    {
      ...defaultAnswers('my-shop', PRESETS.full as readonly AppName[]),
      scope: '@myshop',
      productName: '我的小店',
      domainName: '订单',
      domainSlug: 'order',
      ...overrides,
    },
    MANIFEST.taizanVersion,
  )
}

/** 渲染整份模板到一个临时目录，返回目录路径。 */
function renderAll(v: ReturnType<typeof vars>): string {
  const dir = scratch()
  const keep = (b: Bucket): boolean =>
    (ALL_APPS as readonly string[]).includes(b) ? v.apps.includes(b as AppName) : true
  renderTemplates(TEMPLATES, dir, v, MANIFEST, keep)
  return dir
}

// ─────────────────────────────────────────────────────────────────────────────
describe('改写规则（快照期把可替换点换成 {{变量}}）', () => {
  const at = (p: string, text: string, inExample = false) =>
    applyTextRules(p, text, inExample).output

  it('七个端与三个配置包换 scope，框架包**保持原名**', () => {
    // 这是整张规则表里最容易搞错的一条：生成项目从 npm 装框架包，改了名就装不到。
    expect(at('apps/api/package.json', '"@taizan/api": "workspace:*"')).toContain('{{scope}}/api')
    expect(at('apps/api/tsconfig.json', '"@taizan/tsconfig/node.json"')).toContain(
      '{{scope}}/tsconfig',
    )
    expect(at('apps/api/src/x.ts', "import { X } from '@taizan/contracts'")).toBe(
      "import { X } from '@taizan/contracts'",
    )
    expect(at('apps/api/src/x.ts', "from '@taizan/nest-prisma'")).toContain('@taizan/nest-prisma')
  })

  it('受保护字面量一个都不动（bin 名与 npm 脚本名）', () => {
    for (const literal of PROTECTED_LITERALS) {
      expect(at('apps/api/package.json', `"x": "${literal} prisma/schema"`)).toContain(literal)
    }
  })

  it('项目名 / 数据库名 / pm2 进程名 / 环境变量前缀', () => {
    expect(at('deploy/pm2/ecosystem.config.cjs', "name: 'taizan-api'")).toBe(
      "name: '{{projectName}}-api'",
    )
    expect(at('deploy/docker/docker-compose.dev.yml', 'MYSQL_DATABASE: taizan_dev')).toBe(
      'MYSQL_DATABASE: {{projectSlug}}_dev',
    )
    expect(at('deploy/scripts/remote-deploy.sh', '${TAIZAN_APP_DIR:-/www/taizan-saas}')).toBe(
      // 末尾的 `}} }` 不是笔误：源码里那个 `}` 紧挨着我们插进去的 `{{projectName}}`，
      // 不隔开一个空格的话 Handlebars 会把三个右花括号当成「不转义输出」的收尾去解析。
      '${ {{projectConst}}_APP_DIR:-/www/{{projectName}} }',
    )
  })

  it('品牌位与域名', () => {
    expect(at('apps/site/src/config/BRAND.ts', "productName: '钛赞 SaaS'")).toBe(
      "productName: '{{productName}}'",
    )
    expect(at('deploy/nginx/admin.conf', 'server_name admin.example.com;')).toBe(
      'server_name admin.{{rootDomain}};',
    )
  })

  it('端口只在白名单文件里换（散文里的 3000 不动）', () => {
    expect(at('apps/api/.env.example', 'API_PORT=3000')).toBe('API_PORT={{apiPort}}')
    expect(at('apps/api/README.md', '压测到 3000 QPS')).toBe('压测到 3000 QPS')
  })

  it('业务域：标识符全量换，中文名只在示例文件/标记区间内换', () => {
    expect(at('apps/api/src/registry/jobs.ts', "GOODS_SYNC_JOB_NAME = 'goods.sync'")).toBe(
      "{{DOMAIN_UPPER}}_SYNC_JOB_NAME = '{{domainSlug}}.sync'",
    )
    expect(at('apps/api/src/registry/features.ts', "  name: '商品模块',")).toBe(
      "  name: '商品模块',",
    )
    expect(at('apps/api/src/registry/features.ts', "  name: '商品模块',", true)).toBe(
      "  name: '{{domainName}}模块',",
    )
    // 示例目录整份文件都算示例，不需要标记
    expect(at('apps/api/src/modules/example-goods/goods.menus.ts', "title: '商品'")).toBe(
      "title: '{{domainName}}'",
    )
  })

  it('源码里原本就有的 {{ 被转义（不会被当成模板表达式吃掉）', () => {
    expect(at('apps/api/README.md', '写成 {{projectName}} 的样子')).toContain('\\{{projectName}}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('渲染', () => {
  it('.hbs 去后缀、路径里的变量被替换、_gitignore 变回 .gitignore', () => {
    const v = vars()
    expect(
      targetPathOf(
        {
          path: 'apps/api/src/modules/example-{{domainSlug}}/{{domainSlug}}.module.ts.hbs',
          render: true,
        } as never,
        v,
      ),
    ).toBe('apps/api/src/modules/example-order/order.module.ts')
    expect(targetPathOf({ path: '_gitignore', render: false } as never, v)).toBe('.gitignore')
    // codegen 自己的模板原样带走，`.hbs` 后缀必须留着。
    expect(
      targetPathOf(
        { path: 'tools/codegen/templates/module/dto.ts.hbs', render: false } as never,
        v,
      ),
    ).toBe('tools/codegen/templates/module/dto.ts.hbs')
  })

  it('不做 HTML 转义（模板是源码，不是页面）', () => {
    // 默认的 Handlebars 会把 `&&` 变成 `&amp;&amp;`，生成出来的项目连 parse 都过不了。
    expect(renderText("if (a && b) return '{{scope}}'", vars())).toBe(
      "if (a && b) return '@myshop'",
    )
  })

  it('整份模板渲染完，产物里不该再有未替换的 {{ 变量', () => {
    /**
     * 允许保留双花括号的地方，**每一条都要说得出理由**。
     *
     * 这不是「白名单一开就万事大吉」：双花括号在生成出来的项目里有两种完全不同的身份——
     * 一种是生成器没渲染干净的漏网之鱼（bug），另一种是**运行期**的占位符
     * （通知模板的 `{{name}}` 是发短信时才填的）与文档里对生成器变量的引用。
     * 白名单存在的意义就是逼着每一条说清自己是后者。
     */
    const ALLOWED: ReadonlyArray<readonly [pattern: RegExp, why: string]> = [
      [
        /apps[\\/]api[\\/]prisma[\\/]schema[\\/]00-base[\\/]08-notify\.prisma$/,
        '通知模板表的注释里举了 {{var}} 的例子——那是**发送时**才填的占位符。',
      ],
      [
        /apps[\\/]api[\\/]src[\\/]registry[\\/]notify-templates\.ts$/,
        '通知模板正文里的 {{name}} 同上：运行期占位符，不是生成器变量。',
      ],
      [
        /apps[\\/]site[\\/](README\.md|src[\\/]config[\\/]BRAND\.ts)$/,
        '这两处是**文档**：它们在讲「生成器会把品牌位换成 {{productName}}」这件事本身。',
      ],
      [
        /tools[\\/]codegen[\\/]templates[\\/]/,
        'codegen 自己的模板原样带走，里面的 {{slug}} 是它的占位符，不是我们的。',
      ],
    ]
    const dir = renderAll(vars())
    const leftovers: string[] = []
    for (const file of walk(dir)) {
      if (!/\.(ts|tsx|json|prisma|md|ya?ml|conf|cjs|sh|html|example)$/.test(file)) continue
      if (ALLOWED.some(([pattern]) => pattern.test(file))) continue
      const text = readFileSync(file, 'utf8')
      const m = text.match(/\{\{[a-zA-Z#/][^}\n]*\}\}/)
      if (m) leftovers.push(`${file.slice(dir.length + 1)}: ${m[0]}`)
    }
    expect(leftovers).toEqual([])
  })

  it('产物里没有残留的 Handlebars 转义符（`\\{{`）', () => {
    // 转义是**模板里**的写法；渲染完还留着说明有一层没被 Handlebars 处理过，
    // 生成出来的项目里就会出现字面量的反斜杠。
    const dir = renderAll(vars())
    const bad: string[] = []
    for (const file of walk(dir)) {
      if (file.includes(join('tools', 'codegen', 'templates'))) continue
      if (!/\.(ts|tsx|json|prisma|md|ya?ml|conf|cjs|sh)$/.test(file)) continue
      if (readFileSync(file, 'utf8').includes('\\{{')) bad.push(file.slice(dir.length + 1))
    }
    expect(bad).toEqual([])
  })

  it('生成项目里必须带的五样东西都在', () => {
    const dir = renderAll(vars())
    for (const f of [
      'CLAUDE.md',
      'README.md',
      'deploy/nginx/api.conf',
      '.github/workflows/ci.yml',
      'apps/api/.env.example',
    ]) {
      expect(existsSync(join(dir, f.split('/').join(sep))), f).toBe(true)
    }
  })

  it('框架包写的是版本号，端与配置包仍是 workspace:*', () => {
    const dir = renderAll(vars())
    const api = JSON.parse(readFileSync(join(dir, 'apps', 'api', 'package.json'), 'utf8'))
    expect(api.name).toBe('@myshop/api')
    expect(api.dependencies['@taizan/contracts']).toBe(MANIFEST.taizanVersion)
    expect(api.devDependencies['@myshop/tsconfig']).toBe('workspace:*')
    expect(JSON.stringify(api)).not.toContain('"workspace:*"' + '@taizan/')
  })

  it('生成项目里没有任何 workspace: 指向框架包（那是装不上的）', () => {
    const dir = renderAll(vars())
    for (const file of walk(dir)) {
      if (!file.endsWith('package.json')) continue
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const [name, range] of Object.entries((pkg[field] ?? {}) as Record<string, string>)) {
          if (name.startsWith('@taizan/')) {
            expect(range, `${file} ${name}`).not.toMatch(/^workspace:/)
          }
        }
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('裁剪（--preset=api-only）', () => {
  const apiOnly = () => vars({ apps: ['api'] })

  it('未选的端目录一个都不在', () => {
    const dir = renderAll(apiOnly())
    prune(dir, apiOnly())
    expect(readdirSync(join(dir, 'apps'))).toEqual(['api'])
  })

  it('nginx / workspace / turbo / 根 package.json 里没有悬空引用', () => {
    const v = apiOnly()
    const dir = renderAll(v)
    prune(dir, v)

    for (const app of ['admin', 'platform', 'site', 'client']) {
      expect(existsSync(join(dir, 'deploy', 'nginx', `${app}.conf`)), app).toBe(false)
    }
    const ws = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(ws).not.toContain('apps/admin')
    // `apps/*` 通配是允许的：它匹配不到已删的目录。
    expect(ws).toContain('apps/*')

    const turbo = JSON.parse(readFileSync(join(dir, 'turbo.json'), 'utf8'))
    expect(JSON.stringify(turbo)).not.toMatch(/admin|platform|site|client/)

    const rootPkg = readFileSync(join(dir, 'package.json'), 'utf8')
    for (const app of ['admin', 'platform', 'site', 'client']) {
      expect(rootPkg, app).not.toContain(`@myshop/${app}`)
    }
  })

  it('menu-route-map spec 认「前端可能不存在」，不硬读 apps/admin', () => {
    // 不改的话，api-only 的 `pnpm test` 会在 import 期直接抛，
    // 而错误信息说的是「解析不出 componentKey」——离「你没选 admin」很远。
    // 这一处是在**快照期**改好的（src/file-patches.ts），所以每个生成项目都一样。
    const v = apiOnly()
    const dir = renderAll(v)
    prune(dir, v)
    const spec = readFileSync(
      join(dir, 'apps', 'api', 'test', 'arch', 'menu-route-map.spec.ts'),
      'utf8',
    )
    expect(spec).toContain('ADMIN_COMPONENT_MAP_EXISTS')
    expect(spec).toContain('describe.skipIf(CHECKED_SIDES.length === 0)')
    expect(spec).toContain('const flat = flatten(MENUS_UNDER_CHECK)')
  })

  it('扫 packages/ 的那几条 arch spec 都带了「目录不存在」的兜底', () => {
    // 业务项目里没有 packages/（框架是从 npm 装的）。不兜底的话 readdirSync 直接
    // ENOENT，整份 pnpm test 在 import 期就红，而报错说的是 scandir 失败。
    const v = apiOnly()
    const dir = renderAll(v)
    prune(dir, v)
    for (const f of ['ip-source.spec.ts', 'response-shape.spec.ts']) {
      const spec = readFileSync(join(dir, 'apps', 'api', 'test', 'arch', f), 'utf8')
      expect(spec, f).toContain('if (!existsSync(PACKAGES_DIR)) return out')
      expect(spec, f).toContain('import { existsSync, readdirSync')
    }
  })

  it('prisma/migrations 目录带着 migration_lock.toml 一起生成', () => {
    // base-schema-integrity.spec 有一条「迁移目录在 prisma/migrations 而不是
    // 00-base/ 旁边」的断言；目录不存在那条就红。迁移**内容**不带走（里面写死了
    // 示例的表名），只带这一个记 provider 的文件。
    const v = apiOnly()
    const dir = renderAll(v)
    expect(
      existsSync(join(dir, 'apps', 'api', 'prisma', 'migrations', 'migration_lock.toml')),
    ).toBe(true)
    expect(
      existsSync(join(dir, 'apps', 'api', 'prisma', 'migrations', '20260905073408_init')),
    ).toBe(false)
  })

  it('保留示例时，标记注释本身要被删掉（那是给生成器看的）', () => {
    const v = vars()
    const dir = renderAll(v)
    prune(dir, v)
    for (const file of walk(dir)) {
      if (!/\.(ts|tsx|prisma|json)$/.test(file)) continue
      expect(readFileSync(file, 'utf8'), file).not.toContain('@taizan-example-')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('裁剪（不保留示例模块）', () => {
  const noExample = () =>
    vars({ apps: ['api', 'admin', 'platform', 'site'], includeExample: false })

  it('示例目录与 schema 片段都没了', () => {
    const v = noExample()
    const dir = renderAll(v)
    prune(dir, v)
    expect(existsSync(join(dir, 'apps', 'api', 'src', 'modules', 'example-order'))).toBe(false)
    expect(
      existsSync(join(dir, 'apps', 'api', 'prisma', 'schema', '10-business', '10-order.prisma')),
    ).toBe(false)
    expect(existsSync(join(dir, 'apps', 'admin', 'src', 'pages', 'order'))).toBe(false)
  })

  it('七处注册里都不再提示例模块（这是「删干净了」的判据）', () => {
    const v = noExample()
    const dir = renderAll(v)
    prune(dir, v)
    const files = [
      'apps/api/src/tenancy/tenant-models.ts',
      'apps/api/src/registry/permissions.ts',
      'apps/api/src/registry/menus.ts',
      'apps/api/src/registry/features.ts',
      'apps/api/src/registry/audit-actions.ts',
      'apps/api/src/registry/jobs.ts',
      'apps/api/src/bootstrap/app.module.ts',
      'apps/admin/src/routes/component-map.ts',
    ]
    for (const f of files) {
      // 先把注释剥掉再断言：注释里还留着「示例长什么样」是文档，**代码里的引用**才是问题。
      // 不剥的话这条 spec 会被一句人话卡住，而人的反应通常是把断言放宽——那就等于没测。
      const code = stripComments(readFileSync(join(dir, f.split('/').join(sep)), 'utf8'))
      expect(code, f).not.toMatch(/modules\/example-order/)
      expect(code, f).not.toMatch(/\bORDER_(PERMISSIONS|MENUS|SYNC_JOB_NAME)\b/)
      expect(code, f).not.toMatch(/\bOrderModule\b/)
      expect(code, f).not.toMatch(/\bOrderList\b/)
    }
  })

  it('三个 C 端与「不保留示例」互斥，且是在生成之前就拒绝', () => {
    // 那三个端唯一的业务界面就是示例页面，删了示例它们是空壳——
    // 让它们生成出来再让用户发现「build 不过」，是最差的顺序。
    expect(() => vars({ apps: ['api', 'client'], includeExample: false })).toThrow(/不保留示例/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('manifest 与 --check', () => {
  it('清单里的每个文件都在磁盘上，sha256 对得上', () => {
    for (const entry of MANIFEST.files) {
      const abs = join(TEMPLATES, entry.path.split('/').join(sep))
      expect(existsSync(abs), entry.path).toBe(true)
      const sha = createHash('sha256').update(readFileSync(abs)).digest('hex')
      expect(sha, entry.path).toBe(entry.sha256)
    }
  })

  it('磁盘上的每个文件都在清单里（没有游离文件）', () => {
    const listed = new Set(MANIFEST.files.map((f) => f.path))
    for (const abs of walk(TEMPLATES)) {
      const rel = abs
        .slice(TEMPLATES.length + 1)
        .split(sep)
        .join('/')
      if (rel === 'manifest.json') continue
      expect(listed.has(rel), rel).toBe(true)
    }
  })

  it('`build:templates --check` 在没改过任何东西时通过', () => {
    // 这条会真的重新扫一遍 apps/，是整个生成器里唯一一条「模板没过期」的断言。
    //
    // `stdio: 'pipe'` 是故意的（不让漂移清单混进正常测试输出），但代价是失败时
    // execFileSync 抛的 Error 只有一句 `Command failed: node ...`，漂移清单躺在
    // `error.stderr` 这个 Buffer 里，而 vitest 把它序列化成
    //   Serialized Error: { ..., stderr: '<Buffer(360) ...>' }
    // ——CI 上看得见「有 360 字节」，看不见是哪个文件漂了，只能本地重跑一遍才知道。
    // 所以这里自己接住，把子进程的 stderr/stdout 解成文本拼进错误信息。
    try {
      execFileSync(
        'node',
        ['--import', 'tsx', join(PKG_ROOT, 'scripts', 'build-templates.ts'), '--check'],
        {
          cwd: PKG_ROOT,
          stdio: 'pipe',
        },
      )
    } catch (err) {
      const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string }
      const text = (b: Buffer | string | undefined): string =>
        b == null ? '' : (Buffer.isBuffer(b) ? b.toString('utf8') : b).trim()
      // Node 有时已经把 stderr 拼进 message，有时没有（取决于平台/调用方式），
      // 所以只补 message 里还没有的那部分，避免同一份漂移清单打印两遍。
      const detail = [text(e.stderr), text(e.stdout)]
        .filter((t) => t && !e.message.includes(t))
        .join('\n')
      throw new Error(
        ['build:templates --check 失败（模板快照与 apps/ 不一致）：', e.message, detail]
          .filter(Boolean)
          .join('\n'),
        { cause: err },
      )
    }
  })

  it('每个端至少有一个文件（漏抓一整个端不该静默）', () => {
    for (const app of ALL_APPS) {
      expect(
        MANIFEST.files.some((f) => f.bucket === app),
        app,
      ).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('非交互路径（--yes）', () => {
  it('每个 preset 都能算出合法上下文，且 api 恒在', () => {
    for (const [name, apps] of Object.entries(PRESETS)) {
      const v = buildContext(defaultAnswers('demo', apps), MANIFEST.taizanVersion)
      expect(v.apps, name).toContain('api')
    }
  })

  it('非法项目名 / scope / slug 在这里就被拒绝（--yes 也走同一条校验）', () => {
    expect(() => buildContext(defaultAnswers('My-Shop', ['api']), '^0.1.0')).toThrow(/项目名/)
    expect(() =>
      buildContext({ ...defaultAnswers('demo', ['api']), scope: 'myshop' }, '^0.1.0'),
    ).toThrow(/scope/)
    expect(() =>
      buildContext({ ...defaultAnswers('demo', ['api']), domainSlug: 'Order' }, '^0.1.0'),
    ).toThrow(/slug/)
  })
})

/** 把行注释与块注释剥掉，只留代码。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const abs = join(dir, name)
    const stat = existsSync(abs) ? readdirSyncSafe(abs) : null
    if (stat) yield* walk(abs)
    else yield abs
  }
}

/** 是目录就返回它的条目，否则 `null`。用它代替 `statSync` 只是为了少一个 import。 */
function readdirSyncSafe(p: string): string[] | null {
  try {
    return readdirSync(p)
  } catch {
    return null
  }
}
