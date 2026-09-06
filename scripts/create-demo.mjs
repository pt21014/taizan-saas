/**
 * `pnpm create:demo` —— **生成器的端到端验收**。
 *
 * 在系统临时目录里真的生成两个项目、真的装依赖、真的编译、真的跑测试：
 *
 * | 步 | 做什么 | 它证明了什么 |
 * |---|---|---|
 * | 0 | `build:templates` | 模板与当前 `apps/**` 一致 |
 * | 1 | `create ... --preset=full --yes` | 六端全开能生成 |
 * | 2 | 装依赖（`@taizan/*` 用 overrides 指向本仓库 `packages/`） | 依赖清单是完整的 |
 * | 3 | `schema-sync` + `prisma generate` + `build` | 七个端都能编译出产物 |
 * | 4 | `test`（单测 + 架构约束 16 条） | 不变量在生成出来的项目里同样成立 |
 * | 5 | `migrate` + `seed` + `test:e2e`（要 `pnpm dev:infra`） | 真库真 Redis 下隔离/权限/账单闸门都对 |
 * | 6 | `create ... --preset=api-only --yes` 再来一遍 build+test | 裁剪之后没有悬空引用 |
 * | 7 | `build:templates --check` | 前面几步没有偷偷改过 apps/ 或 templates/ |
 *
 * ## 为什么是 `pnpm pack` + `file:` 而不是 `link:`
 *
 * `@taizan/*` 还没发布到 npm。生成出来的项目里写的是 `"@taizan/contracts": "^0.1.0"`，
 * 那是**将来**的真实形态；现在要让它装得上，只能把这些名字重定向到本地。
 *
 * 第一版用的是 `link:<repo>/packages/x`，**不行**：`link:` 是符号链接，被链接的包
 * 继续从**框架仓库自己的** node_modules 解析 `@nestjs/core`，而生成项目有另一份。
 * 于是进程里存在两个 `Reflector` 类，DI 按类做 token 比对，直接报
 * 「Nest can't resolve dependencies of the TransformInterceptor (?)」——
 * 一个与生成器毫无关系、却极难看出根因的错误。
 *
 * 所以改成 `pnpm pack` 打成 tarball，再用 `file:<tgz>` 装。这条路**就是真实的
 * npm 安装路径**：依赖从生成项目这边解析，而且顺带验了每个包的 `files` 字段
 * ——漏打 dist 的包在这里就会暴露，而不是等到发布之后。
 *
 * 代价是慢（26 个包各打一次），以及要求 `packages/*` 先 build 过。
 *
 * ## 数据库
 *
 * 用本仓库 `pnpm dev:infra` 起的那套（MySQL 3307 / Redis 6380），但：
 * - 库名是 `demo_<随机>`，跑完即删——不污染 `taizan_dev`；
 * - Redis 用 **10 号库**（本仓库自己的开发库是 0 号）。
 *
 * ## 用法
 *
 * ```bash
 * pnpm create:demo                 # 全套
 * pnpm create:demo --skip-db       # 跳过第 5 步（没起 dev:infra 时）
 * pnpm create:demo --keep          # 跑完不删临时目录（要去里面看东西时）
 * pnpm create:demo --link-frontend # 三个前端包退回 link:（见 LINK_FRONTEND 注释）
 * ```
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const IS_WIN = process.platform === 'win32'

const args = process.argv.slice(2)
const SKIP_DB = args.includes('--skip-db')
const KEEP = args.includes('--keep')
/**
 * `--link-frontend`：三个前端包（见 `FRONTEND_PACKAGES`）退回 `link:` 而不是 tarball。
 *
 * 默认**不开**——三个前端包和 Nest 侧一样走真实的 `pnpm pack` + `file:`，理由见上面
 * 「为什么是 `pnpm pack` + `file:` 而不是 `link:`」。这曾经是默认关不掉的：
 * `@taizan/admin-ui` 的构建产物里有一句 `import 'antd/locale/zh_CN'`（没有 `.js`
 * 后缀），装成真实 npm 依赖后 Node 的 ESM 解析器会报
 * 「Cannot find module … Did you mean antd/locale/zh_CN.js?」（T4-1）。
 * 已在 `packages/admin-ui/src/theme/TaizanConfigProvider.tsx` 修好（改成
 * `antd/locale/zh_CN.js`，`packages/admin-ui/scripts/check-dist-resolve.mjs`
 * 挂在它的 `test` 里防回归），所以这里改回默认 tarball。
 *
 * 留这个开关只是兜底：如果以后又冒出一个同类深路径 import 问题，能先绕过去继续
 * 跑通生成器验收，而不是被前端包的打包缺陷卡住整条流水线。
 */
const LINK_FRONTEND = args.includes('--link-frontend')

/** `--link-frontend` 时退回 `link:` 的前端包，理由见 `LINK_FRONTEND`。 */
const FRONTEND_PACKAGES = ['@taizan/admin-ui', '@taizan/app-ui', '@taizan/client-core']

const DB_HOST = process.env.DEMO_DB_HOST ?? '127.0.0.1'
const DB_PORT = process.env.DEMO_DB_PORT ?? '3307'
const DB_USER = process.env.DEMO_DB_USER ?? 'root'
const DB_PASS = process.env.DEMO_DB_PASS ?? 'taizan_dev_root'
const REDIS_URL = process.env.DEMO_REDIS_URL ?? 'redis://127.0.0.1:6380/10'
const DB_NAME = `demo_${Math.random().toString(36).slice(2, 8)}`

/**
 * 把 `packages/*` 全部 `pnpm pack` 成 tarball，返回「包名 → `file:` 地址」。
 *
 * 只跑一次，两个 demo 项目共用同一批 tarball。
 */
let cachedOverrides = null
function frameworkOverrides(outDir) {
  if (cachedOverrides !== null) return cachedOverrides
  mkdirSync(outDir, { recursive: true })
  const out = {}
  const linkedOnly = new Set(LINK_FRONTEND ? FRONTEND_PACKAGES : [])
  for (const dir of readdirSync(join(REPO, 'packages'))) {
    const pkgDir = join(REPO, 'packages', dir)
    const pkgPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.private === true) continue
    if (linkedOnly.has(pkg.name)) {
      out[pkg.name] = `link:${toPosix(pkgDir)}`
      continue
    }
    const printed = execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
      cwd: pkgDir,
      encoding: 'utf8',
      shell: IS_WIN,
    })
    // `pnpm pack` 把 tarball 的绝对路径打在最后一行。
    const tgz = printed.trim().split(/\r?\n/).pop().trim()
    if (!existsSync(tgz)) throw new Error(`pnpm pack 没产出 tarball：${pkg.name} → ${tgz}`)
    out[pkg.name] = `file:${toPosix(tgz)}`
  }
  cachedOverrides = out
  return out
}

/** Windows 路径 → POSIX 斜杠。写进 YAML 的路径必须是斜杠，反斜杠会被当转义符。 */
function toPosix(p) {
  return p.split('\\').join('/')
}

let step = 0
function banner(text) {
  step += 1
  console.log('')
  console.log(`\u001b[36m━━ ${step}. ${text} ━━\u001b[0m`)
}

function run(cmd, cmdArgs, cwd, env = {}) {
  console.log(
    `\u001b[2m  $ ${cmd} ${cmdArgs.join(' ')}\u001b[0m  ${cwd === REPO ? '' : `(${cwd})`}`,
  )
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: 'inherit',
    shell: IS_WIN,
    env: { ...process.env, ...env },
  })
  if (r.status !== 0) {
    throw new Error(`失败（退出码 ${r.status}）：${cmd} ${cmdArgs.join(' ')}\n  目录：${cwd}`)
  }
}

function mysql(sql) {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      process.env.DEMO_MYSQL_CONTAINER ?? 'taizan-mysql-dev',
      'mysql',
      `-u${DB_USER}`,
      `-p${DB_PASS}`,
      '-e',
      sql,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
}

/**
 * 生成一个项目并把 `@taizan/*` 重定向到本仓库。
 *
 * `--skip-install` + 这里手动装：生成器自己的 postinstall 会在没有 overrides 的情况下
 * 去 npm 找 `@taizan/contracts@^0.1.0`，那是必然失败的（还没发布）。
 */
function generate(workdir, name, preset, tarballDir) {
  run(
    'node',
    [
      join(REPO, 'tools', 'create-taizan-saas', 'dist', 'index.js'),
      name,
      `--preset=${preset}`,
      '--yes',
      `--from=${REPO}`,
      '--skip-install',
      '--skip-git',
    ],
    workdir,
  )
  const projectDir = join(workdir, name)
  // pnpm 11 把 overrides 之类的设置搬进了 `pnpm-workspace.yaml`（不再读 package.json
  // 的 `pnpm.overrides`）。直接追加几行 YAML——比引一个 yaml 库省事，而且这份文件
  // 是我们自己生成的，缩进不会有意外。
  const wsPath = join(projectDir, 'pnpm-workspace.yaml')
  const lines = ['', 'overrides:']
  for (const [pkgName, target] of Object.entries(frameworkOverrides(tarballDir))) {
    lines.push(`  '${pkgName}': '${target}'`)
  }
  writeFileSync(wsPath, readFileSync(wsPath, 'utf8').trimEnd() + lines.join('\n') + '\n')
  // 生成项目默认不带 lockfile；本地 link 的包版本会变，用非 frozen 安装。
  run('pnpm', ['install', '--no-frozen-lockfile'], projectDir)
  return projectDir
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'taizan-demo-'))
  console.log(`临时目录：${work}`)
  let dbCreated = false

  try {
    const tarballDir = join(work, '.tarballs')

    banner('build:templates（模板与当前 apps/ 一致）')
    run('pnpm', ['-F', 'create-taizan-saas', 'build:templates'], REPO)
    run('pnpm', ['-F', 'create-taizan-saas', 'build'], REPO)

    banner('打包 @taizan/* （pnpm pack → 本地 tarball，模拟从 npm 装）')
    // 先确保 packages/* 都构建过：pack 只是打包，不会替你 build，
    // 而漏了 dist 的 tarball 装上去是「能装、一 import 就找不到模块」。
    run('pnpm', ['--filter', './packages/*', 'build'], REPO)

    // ── full ────────────────────────────────────────────────────────────
    banner('生成 full 项目（六端全开）')
    const full = generate(work, 'demo', 'full', tarballDir)

    banner('full：schema-sync + prisma generate')
    run('pnpm', ['taizan:schema-sync'], full)
    run('pnpm', ['prisma:generate'], full)

    banner('full：pnpm build')
    run('pnpm', ['build'], full)

    banner('full：pnpm test（单测 + 架构约束 16 条）')
    run('pnpm', ['test'], full)

    if (!SKIP_DB) {
      banner(`full：真库 e2e（库 ${DB_NAME}，Redis 10 号）`)
      mysql(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4;`)
      dbCreated = true
      const dbUrl = `mysql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}`
      writeFileSync(join(full, 'apps', 'api', '.env'), envFile(dbUrl))
      run('pnpm', ['-F', '@demo/api', 'exec', 'prisma', 'migrate', 'dev', '--name', 'init'], full, {
        DATABASE_URL: dbUrl,
      })
      run('pnpm', ['seed'], full, { DATABASE_URL: dbUrl, REDIS_URL })
      run('pnpm', ['test:e2e'], full, { DATABASE_URL: dbUrl, REDIS_URL })
    } else {
      banner('full：真库 e2e —— 按 --skip-db 跳过')
    }

    // ── api-only ────────────────────────────────────────────────────────
    banner('生成 api-only 项目（证明裁剪之后仍然绿）')
    const apiOnly = generate(work, 'demo-api', 'api-only', tarballDir)
    for (const app of ['admin', 'platform', 'site', 'client', 'app-client', 'app-merchant']) {
      if (existsSync(join(apiOnly, 'apps', app))) throw new Error(`api-only 里不该有 apps/${app}`)
    }
    run('pnpm', ['taizan:schema-sync'], apiOnly)
    run('pnpm', ['prisma:generate'], apiOnly)
    run('pnpm', ['build'], apiOnly)
    run('pnpm', ['test'], apiOnly)

    banner('build:templates --check（跑完这一路没有偷偷改过谁）')
    run('pnpm', ['-F', 'create-taizan-saas', 'build:templates:check'], REPO)

    console.log('')
    console.log('\u001b[32m\u001b[1m✔ create:demo 全绿\u001b[0m')
    console.log(`  full     ${full}`)
    console.log(`  api-only ${apiOnly}`)
  } finally {
    if (dbCreated) {
      try {
        mysql(`DROP DATABASE IF EXISTS \`${DB_NAME}\`;`)
        console.log(`\u001b[2m  已删除临时库 ${DB_NAME}\u001b[0m`)
      } catch {
        console.warn(`\u001b[33m  临时库 ${DB_NAME} 没删掉，手动清理。\u001b[0m`)
      }
    }
    if (KEEP) console.log(`\u001b[2m  --keep：保留 ${work}\u001b[0m`)
    else rmSync(work, { recursive: true, force: true })
  }
}

/**
 * 生成项目的 `.env`。
 *
 * 密钥是**测试专用**的固定值——库名随机、跑完即删，这些值进不了任何真实环境。
 * 字段清单跟着 `apps/api/src/config/env.ts` 的 zod schema 走（`[必填]` 的那几条）：
 * 少一条应用启动就拒启，而那正是它该做的事——所以这里必须写全，不能只写「大概几个」。
 */
function envFile(databaseUrl) {
  return [
    'NODE_ENV=test',
    // 端口刻意避开 3000：本机很可能正跑着框架仓库自己的 api。
    'API_PORT=3100',
    'API_BASE_URL=http://localhost:3100',
    `DATABASE_URL=${databaseUrl}`,
    `REDIS_URL=${REDIS_URL}`,
    // 三套签名密钥必须互不相同：同一把密钥意味着一张商家 token 能当平台 token 用。
    'JWT_SECRET_PLATFORM=demo-platform-secret-demo-platform-0001',
    'JWT_SECRET_STAFF=demo-staff-secret-demo-staff-secret-0001',
    'JWT_SECRET_MEMBER=demo-member-secret-demo-member-secret-01',
    'CRYPTO_KEYS={"k1":"0000000000000000000000000000000000000000000000000000000000000001"}',
    'CRYPTO_KEY_CURRENT=k1',
    'BILLING_ENFORCE=false',
    'CRON_ENABLED=false',
    'QUEUE_ENABLED=true',
    'PAY_FAKE_ENABLED=true',
    'SIGNUP_ENABLED=true',
    'CLIENT_DEV_LOGIN=true',
    'SMS_RETURN_DEV_CODE=true',
  ].join('\n')
}

main().catch((e) => {
  console.error('')
  console.error(`\u001b[31m✘ create:demo 失败\u001b[0m`)
  console.error(String(e.message ?? e))
  process.exitCode = 1
})
