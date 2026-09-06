/**
 * 验收 e2e 的**脚手架**：把「从空目录到一个正在监听端口的生成项目」这段编排收在这里，
 * 让 `acceptance.spec.ts` 里只剩蓝图 §6 的 9 条判据本身。
 *
 * 这一层做的事，按顺序：
 *
 * | 步 | 做什么 | 为什么必须真做 |
 * |---|---|---|
 * | 1 | `pnpm pack` 全部 `packages/*` → 本地 tarball | 这就是真实的 npm 安装路径（见下） |
 * | 2 | 调生成器 `--preset=full --yes --from=<本仓库> --skip-install` | 交付形态是生成器的产物，不是本仓库 |
 * | 3 | 写 `pnpm-workspace.yaml` 的 `overrides` + `pnpm install` | `@taizan/*` 还没发布，得重定向到本地 |
 * | 4 | `schema-sync` → `prisma migrate dev --name init` → `prisma generate` | 模板只带 `migration_lock.toml`（见下） |
 * | 5 | `seed` | 平台超管、TRIAL 租户、店主、会员、两档套餐 |
 * | 6 | `tsup` 打包 api，`node dist/main.js` 起子进程 | 跑的是**构建产物**，不是 tsx 解释源码 |
 * | 7 | 轮询 `/health` 直到 200 | 起不来就没有「9 条全绿」这回事 |
 *
 * ## 为什么 tarball 而不是 `link:`
 *
 * 与 `scripts/create-demo.mjs` 同一条结论，这里再记一次（那份文件不在本任务的改动面内，
 * 但两边必须保持同一个理由，否则将来只改一边）：`link:` 是符号链接，被链接的包继续从
 * **框架仓库自己的** `node_modules` 解析 `@nestjs/core`，而生成项目有另一份。进程里于是
 * 存在两个 `Reflector` 类，Nest 的 DI 按类做 token 比对，直接报「can't resolve dependencies
 * of the TransformInterceptor (?)」——一个与生成器毫无关系、却极难看出根因的错误。
 * `pnpm pack` + `file:<tgz>` 让依赖从生成项目这边解析，顺带验了每个包的 `files` 字段。
 *
 * **全部包一视同仁走 tarball**，前端包也不例外。曾经有一段时间三个前端包只能退回 `link:`，
 * 因为 `@taizan/admin-ui` 的产物里有一句无后缀的 `import 'antd/locale/zh_CN'`——装成真实
 * npm 依赖后 Node 的 ESM 解析器直接报「Cannot find module … Did you mean zh_CN.js?」。
 * 那是 T4-1 暴露出来的一处真实缺陷，已在 `packages/admin-ui` 修好（`check-dist-resolve.mjs`
 * 挂在它的 `test` 里防回归），所以这里没有例外项。
 *
 * ## 为什么是 `prisma migrate dev --name init` 而不是 `migrate deploy` / `db push`
 *
 * 模板里 `apps/api/prisma/migrations/` **只有 `migration_lock.toml`**，一条迁移都没有——
 * 这是刻意的：迁移 SQL 是「某一次 schema 的差异」，而生成器会按选项裁掉 `example-goods`、
 * 换掉业务域名字、切 MySQL/PostgreSQL，预生成的 SQL 对其中任何一种组合都是错的。
 * 所以：
 *
 * - `migrate deploy` —— **不行**，没有迁移可部署，跑完是一个空库，seed 立刻炸；
 * - `db push` —— 能建出表，但它绕开迁移引擎，验不到「这份 schema 能生成合法 SQL」；
 * - `migrate dev --name init` —— **选它**。它按当前 schema 生成第一条迁移并应用，
 *   走的是真实迁移引擎（含 shadow database 校验）。
 *
 * 「污染模板」的担心不成立：`migrate dev` 写的是**生成项目**里的
 * `<临时目录>/<项目名>/apps/api/prisma/migrations/`，那个目录跑完就整个删掉；
 * 本仓库的 `tools/create-taizan-saas/templates/` 全程只被读，没有任何一步写它。
 * 最后 `scripts/acceptance.sh` 还会跑一遍 `build:templates:check`（sha256 对账），
 * 万一哪天有人把这条路写歪了，那一步会红。
 *
 * @packageDocumentation
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `tools/create-taizan-saas/e2e` → 仓库根。 */
export const REPO = resolve(HERE, '..', '..', '..')
const IS_WIN = process.platform === 'win32'

/** `--keep`：跑完不删临时目录、不删临时库，留现场手工 curl。 */
export const KEEP = process.env.ACCEPTANCE_KEEP === '1' || process.argv.includes('--keep')

/** 生成出来的项目名（同时决定 scope：`@acc-demo`）。 */
const PROJECT = 'acc-demo'
const SCOPE = `@${PROJECT}`

const DB_HOST = process.env.ACC_DB_HOST ?? '127.0.0.1'
const DB_PORT = process.env.ACC_DB_PORT ?? '3307'
const DB_USER = process.env.ACC_DB_USER ?? 'root'
const DB_PASS = process.env.ACC_DB_PASS ?? 'taizan_dev_root'
/**
 * Redis **12 号库**。
 *
 * 已被占掉的：0 = 本仓库 dev 进程，3 = `apps/api` 的 e2e，5 = CI 的 generator-e2e，
 * 10 = `pnpm create:demo`。共用一个库时 BullMQ 的任务会被旁边的进程抢走，
 * 症状是间歇性假红（详见 `docs/CI.md` §2）。
 */
const REDIS_DB = process.env.ACC_REDIS_DB ?? '12'
const REDIS_HOST = process.env.ACC_REDIS_HOST ?? '127.0.0.1'
const REDIS_PORT = process.env.ACC_REDIS_PORT ?? '6380'

/** 库名随机：同一台机器上并行跑两次验收不会互相踩。 */
const DB_NAME = `acc_${randomBytes(4).toString('hex')}`

const DATABASE_URL = `mysql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}`
const REDIS_URL = process.env.ACC_REDIS_URL ?? `redis://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB}`

/** 起好之后的现场句柄，`acceptance.spec.ts` 拿它发请求。 */
export interface Acceptance {
  /** 生成项目根目录（`<tmp>/acc-demo`）。 */
  projectDir: string
  /** API 基址，例如 `http://127.0.0.1:41234`。 */
  baseUrl: string
  /** 这次用的库名，断言里要打进失败信息。 */
  dbName: string
  databaseUrl: string
  /** 直接对库执行一条 SQL（把 `planExpireAt` 改成昨天时用）。 */
  sql: (statement: string) => Promise<void>
  /** 关进程 + 删库 + 删目录（`--keep` 时只关进程）。 */
  teardown: () => Promise<void>
}

// ─── 打印 ────────────────────────────────────────────────────────────────────

let step = 0
export function banner(text: string): void {
  step += 1
  console.log('')
  console.log(`\u001b[36m━━ 准备 ${step}. ${text} ━━\u001b[0m`)
}

/**
 * 跑一条命令，**异步等它结束**。
 *
 * 为什么一条同步子进程调用都不留：整个 `beforeAll` 跑在 vitest 的 worker 线程里，worker
 * 要不停地通过 RPC 向主进程汇报进度。`pnpm install` 一跑好几分钟，`execFileSync` 会把
 * worker 的事件循环整个卡住，主进程等不到心跳，最后抛
 * 「[vitest-worker]: Timeout calling "onTaskUpdate"」——9 条明明全绿，退出码却是 1。
 * 实测踩过一次，而那条报错完全不指向根因。
 */
async function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  console.log(`[2m  $ ${cmd} ${args.join(' ')}[0m`)
  await once(cmd, args, { cwd, env })
}

interface OnceOptions {
  cwd: string
  env?: Record<string, string>
  /** 收集 stdout 而不是直接透传（`pnpm pack` 要拿 tarball 路径）。 */
  capture?: boolean
  /** 写进子进程 stdin 的内容（`prisma db execute --stdin` 要）。 */
  input?: string
}

/** spawn + await exit。非零退出码抛错，错误信息里带上命令与目录。 */
async function once(cmd: string, args: string[], opts: OnceOptions): Promise<string> {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    shell: IS_WIN,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: [
      opts.input === undefined ? 'ignore' : 'pipe',
      opts.capture === true ? 'pipe' : 'inherit',
      'inherit',
    ],
  })
  if (opts.input !== undefined) child.stdin?.end(opts.input)
  let out = ''
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString('utf8')
  })
  const code = await new Promise<number>((res, rej) => {
    child.once('error', rej)
    child.once('close', (c) => {
      res(c ?? -1)
    })
  })
  if (code !== 0) {
    throw new Error(`失败（退出码 ${code}）：${cmd} ${args.join(' ')}\n  目录：${opts.cwd}`)
  }
  return out
}

/** Windows 路径 → POSIX 斜杠：写进 YAML 的反斜杠会被当转义符。 */
function toPosix(p: string): string {
  return p.split('\\').join('/')
}

// ─── 1. tarball ──────────────────────────────────────────────────────────────

async function frameworkOverrides(outDir: string): Promise<Record<string, string>> {
  mkdirSync(outDir, { recursive: true })
  const out: Record<string, string> = {}
  for (const dir of readdirSync(join(REPO, 'packages'))) {
    const pkgDir = join(REPO, 'packages', dir)
    const pkgPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string; private?: boolean }
    if (pkg.private === true) continue
    // `pnpm pack` 把 tarball 的绝对路径打在最后一行。
    const printed = await once('pnpm', ['pack', '--pack-destination', outDir], {
      cwd: pkgDir,
      capture: true,
    })
    const tgz = (printed.trim().split('\n').pop() ?? '').trim()
    if (!existsSync(tgz)) throw new Error(`pnpm pack 没产出 tarball：${pkg.name} → ${tgz}`)
    out[pkg.name] = `file:${toPosix(tgz)}`
  }
  return out
}

// ─── 2. env ──────────────────────────────────────────────────────────────────

/** 32 字节 hex —— 够长，且每次都不一样（密钥硬编码在验收脚本里是另一种坏味道）。 */
function secret(): string {
  return randomBytes(24).toString('hex')
}

/**
 * 生成项目的 `apps/api/.env`。
 *
 * 与 `scripts/create-demo.mjs` 的那份有两处**故意不同**，正是蓝图 §6 第 ⑧ ⑨ 条要的：
 * - `BILLING_ENFORCE=true` —— 闸门真的会拦（create:demo 里是 false）；
 * - `PAY_FAKE_ENABLED=true` —— 第 ⑨ 条的假回调要能进来（这条两边一致）。
 *
 * 三套 JWT 密钥各随机一把、互不相同：同一把密钥意味着一张商家 token 能当平台 token 用，
 * 而那正是蓝图 §9 第 5 条不变量要挡的事。
 */
function envFile(port: number): string {
  return (
    [
      'NODE_ENV=test',
      `API_PORT=${port}`,
      `API_BASE_URL=http://127.0.0.1:${port}`,
      `DATABASE_URL=${DATABASE_URL}`,
      `REDIS_URL=${REDIS_URL}`,
      `JWT_SECRET_PLATFORM=acc-platform-${secret()}`,
      `JWT_SECRET_STAFF=acc-staff-${secret()}`,
      `JWT_SECRET_MEMBER=acc-member-${secret()}`,
      `CRYPTO_KEYS={"k1":"${randomBytes(32).toString('hex')}"}`,
      'CRYPTO_KEY_CURRENT=k1',
      // ⑧ 的前提：闸门必须真的生效。
      'BILLING_ENFORCE=true',
      // 定时任务关掉：验收要的是「接口行为」，多一个 leader 选举只会让日志更吵。
      'CRON_ENABLED=false',
      'QUEUE_ENABLED=true',
      // ⑨ 的前提：Fake 支付通道。
      'PAY_FAKE_ENABLED=true',
      'SIGNUP_ENABLED=true',
      'CLIENT_DEV_LOGIN=true',
      'SMS_RETURN_DEV_CODE=true',
    ].join('\n') + '\n'
  )
}

// ─── 3. 端口 ─────────────────────────────────────────────────────────────────

/** 让内核挑一个空闲端口，再把它让出来给子进程。 */
async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        rej(new Error('拿不到空闲端口'))
        return
      }
      const { port } = addr
      srv.close(() => {
        res(port)
      })
    })
  })
}

// ─── 4. 主流程 ───────────────────────────────────────────────────────────────

export async function setupAcceptance(): Promise<Acceptance> {
  const work = mkdtempSync(join(tmpdir(), 'taizan-acc-'))
  console.log('')
  console.log(`\u001b[1m验收现场\u001b[0m  临时目录 ${work}`)
  console.log(`           库 ${DB_NAME}   Redis ${REDIS_URL}`)

  const projectDir = join(work, PROJECT)
  const apiDir = join(projectDir, 'apps', 'api')
  let child: ChildProcess | undefined
  let dbCreated = false
  /** `--keep` 时要打出来的地址；起进程之前还是空的。 */
  let keepUrl = '(还没起来)'

  /** 对指定库执行一条 SQL。用生成项目里的 prisma CLI —— 本机不需要装 mysql 客户端，CI 也一样。 */
  async function sqlOn(url: string, statement: string): Promise<void> {
    await once('pnpm', ['exec', 'prisma', 'db', 'execute', '--url', url, '--stdin'], {
      cwd: apiDir,
      input: statement,
    })
  }

  const teardown = async (): Promise<void> => {
    if (KEEP) {
      // 现场要留就留个**活的**：进程不杀，只把它从本进程的事件循环里摘出去
      // （spawn 时的 `detached` + 这里的 `unref`），于是 vitest 能正常退出，
      // 而 `curl <地址>/health` 还连得上——「留现场」留的是能动手的现场，不是一堆文件。
      if (child !== undefined && child.exitCode === null) {
        child.stdout?.removeAllListeners('data')
        child.stderr?.removeAllListeners('data')
        // 管道那两端实际是 net.Socket（有 unref），但 TS 上的静态类型只是 Readable。
        // 不 unref 的话，光 `child.unref()` 还留着两个句柄，事件循环退不出来。
        unrefStream(child.stdout)
        unrefStream(child.stderr)
        child.unref()
      }
      const pid = child?.pid ?? 0
      console.log('')
      console.log(`[33m--keep：现场保留（api 进程还活着）[0m`)
      console.log(`  健康  curl ${keepUrl}/health`)
      console.log(`  目录  ${projectDir}`)
      console.log(`  库    ${DB_NAME}（手动删：DROP DATABASE \`${DB_NAME}\`;）`)
      console.log(
        `  收工  ${IS_WIN ? `taskkill /pid ${pid} /T /F` : `kill ${pid}`}，再删掉上面的目录与库`,
      )
      return
    }
    if (child !== undefined && child.exitCode === null) {
      await killTree(child)
    }
    if (dbCreated) {
      try {
        // MySQL 允许 DROP 掉当前连着的那个库，所以不需要另开一条指向系统库的连接
        // （`prisma db execute` 对 `mysql` / `information_schema` 直接报 P3004）。
        await sqlOn(DATABASE_URL, `DROP DATABASE IF EXISTS \`${DB_NAME}\`;`)
        console.log(`\u001b[2m  已删除临时库 ${DB_NAME}\u001b[0m`)
      } catch {
        console.warn(`\u001b[33m  临时库 ${DB_NAME} 没删掉，手动清理。\u001b[0m`)
      }
    }
    await removeWorkdir(work)
  }

  try {
    banner('打包 @taizan/*（pnpm pack → 本地 tarball）')
    // pack 只是打包，不 build；漏了 dist 的 tarball 装上去是「能装、一 import 就找不到模块」。
    await run('pnpm', ['--filter', './packages/*', 'build'], REPO)
    const overrides = await frameworkOverrides(join(work, '.tarballs'))

    banner(`调生成器：${PROJECT} --preset=full --yes（从空目录起）`)
    await run(
      'node',
      [
        join(REPO, 'tools', 'create-taizan-saas', 'dist', 'index.js'),
        PROJECT,
        '--preset=full',
        '--yes',
        `--from=${REPO}`,
        '--skip-install',
        '--skip-git',
      ],
      work,
    )
    if (!existsSync(apiDir)) throw new Error(`生成器没产出 apps/api：${apiDir}`)

    banner('pnpm install（@taizan/* 重定向到本仓库）')
    const wsPath = join(projectDir, 'pnpm-workspace.yaml')
    const lines = ['', 'overrides:']
    for (const [name, target] of Object.entries(overrides)) lines.push(`  '${name}': '${target}'`)
    writeFileSync(wsPath, readFileSync(wsPath, 'utf8').trimEnd() + lines.join('\n') + '\n')
    await run('pnpm', ['install', '--no-frozen-lockfile'], projectDir)

    banner(`清空 Redis ${REDIS_URL}`)
    // 清空验收专用的那个 Redis 库。库名（12 号）是独占的，但**上一次跑剩下的东西还在**：
    // BullMQ 的已完成任务、限流计数、租户视图缓存。它们大多无害，可「大多」不是判据该
    // 依赖的东西——跨次污染正是 docs/CI.md §2 说的那类间歇假红。用生成项目刚装好的
    // ioredis，不给验收本身加依赖。失败只警告：清不掉不该让 9 条红。
    try {
      await run(
        'node',
        [
          '-e',
          `const R=require('ioredis');const r=new R(process.env.REDIS_URL);` +
            `r.flushdb().then(()=>r.quit()).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})`,
        ],
        apiDir,
        { REDIS_URL },
      )
    } catch {
      console.warn(`[33m  Redis ${REDIS_URL} 没清干净，继续跑（上次的残留可能造成干扰）。[0m`)
    }

    banner(`schema-sync + migrate dev --name init（库 ${DB_NAME}）`)
    // 不预先 CREATE DATABASE：Prisma Migrate 自己会建（顺带也就验了「拿到一台空 MySQL
    // 就能从零把库建起来」这件事）。`prisma db execute` 又连不上 `mysql` 系统库（P3004），
    // 预建反而要多绕一圈。
    dbCreated = true
    const port = await freePort()
    writeFileSync(join(apiDir, '.env'), envFile(port))
    await run('pnpm', ['taizan:schema-sync'], projectDir)
    await run('pnpm', ['exec', 'prisma', 'migrate', 'dev', '--name', 'init'], apiDir, {
      DATABASE_URL,
    })
    await run('pnpm', ['prisma:generate'], projectDir)

    banner('seed（平台超管 / TRIAL 租户 / 店主 / 会员 / 两档套餐）')
    await run('pnpm', ['seed'], projectDir, { DATABASE_URL, REDIS_URL })

    banner('构建 api（tsup）并起进程')
    await run('pnpm', ['-F', `${SCOPE}/api`, 'build'], projectDir)
    const baseUrl = `http://127.0.0.1:${port}`
    keepUrl = baseUrl
    child = spawn(process.execPath, ['dist/main.js'], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL, REDIS_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
      // `--keep` 要把进程留到 vitest 退出之后，得自己一个进程组。
      detached: KEEP,
    })
    pipeChildLogs(child)
    await waitForHealth(child, baseUrl)
    console.log(`\u001b[32m  API 已就绪：${baseUrl}/health\u001b[0m`)

    return {
      projectDir,
      baseUrl,
      dbName: DB_NAME,
      databaseUrl: DATABASE_URL,
      sql: async (s) => {
        await sqlOn(DATABASE_URL, s)
      },
      teardown,
    }
  } catch (e) {
    await teardown()
    throw e
  }
}

/**
 * 删临时目录，带重试。
 *
 * Windows 上刚 `taskkill` 掉的进程，句柄不是同一瞬间释放的（还有 `.pnpm` 里那一堆
 * 硬链接与 esbuild/prisma 的 .exe），紧接着 `rmSync` 有很大概率 EPERM。
 * 这不是框架的问题，所以它**不该让 9 条全绿的验收变红**——但也不能悄悄留下几百 MB 垃圾，
 * 所以重试到底再警告，并把手动清理的路径打出来。
 */
async function removeWorkdir(work: string): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      console.log(`[2m  已删除临时目录 ${work}[0m`)
      return
    } catch (e) {
      if (Date.now() >= deadline) {
        console.warn(
          `[33m  临时目录没删掉（${String((e as Error).message)}）。[0m
` + `[33m  手动清理：${work}[0m`,
        )
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/** 见调用点：管道两端运行期是 net.Socket，静态类型却只是 Readable。 */
function unrefStream(s: NodeJS.ReadableStream | null | undefined): void {
  ;(s as unknown as { unref?: () => void } | null | undefined)?.unref?.()
}

/** 子进程日志前缀 `[api]` —— 断言红了的时候，第一眼要能看到服务端那半边发生了什么。 */
function pipeChildLogs(child: ChildProcess): void {
  const relay = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim() !== '') console.log(`\u001b[2m[api]\u001b[0m ${line}`)
    }
  }
  child.stdout?.on('data', relay)
  child.stderr?.on('data', relay)
}

async function waitForHealth(child: ChildProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 90_000
  let last = ''
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `api 进程还没起来就退了（退出码 ${child.exitCode}）；上面的 [api] 日志是原因。`,
      )
    }
    try {
      const r = await fetch(`${baseUrl}/health`)
      if (r.ok) return
      last = `HTTP ${r.status}`
    } catch (e) {
      last = String((e as Error).message)
    }
    await new Promise((res) => setTimeout(res, 500))
  }
  throw new Error(`90s 内 ${baseUrl}/health 没就绪，最后一次：${last}`)
}

/** Windows 下 `child.kill()` 杀不掉孙子进程（BullMQ worker），得走 taskkill /T。 */
async function killTree(child: ChildProcess): Promise<void> {
  const done = new Promise<void>((res) =>
    child.once('exit', () => {
      res()
    }),
  )
  if (IS_WIN && child.pid !== undefined) {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      child.kill('SIGKILL')
    }
  } else {
    child.kill('SIGTERM')
  }
  await Promise.race([done, new Promise<void>((res) => setTimeout(res, 8_000).unref())])
}

// ─── HTTP 小工具 ─────────────────────────────────────────────────────────────

/** 统一响应包 `{code,message,data}`。`code === 0` 才是成功（蓝图 §4.9）。 */
export interface Envelope<T = unknown> {
  code: number
  message: string
  data: T
}

export interface Called<T = unknown> {
  status: number
  body: Envelope<T>
  /** 失败信息里要贴的「请求 + 响应」原文。 */
  detail: string
}

export interface CallOptions {
  token?: string
  body?: unknown
  headers?: Record<string, string>
}

/**
 * 发一个请求，把「请求 + 响应体」一起带回来。
 *
 * 每条断言失败时都必须能看见这两样——否则「期望 1440301，实际 0」这种信息量为零的
 * 报错要人再手工复现一遍才知道发生了什么。
 */
export async function call<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<Called<T>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // 三维度限流按 IP 分桶：每个调用点给一个独立 IP，免得一串登录把自己限死。
    // （框架侧只认 `resolveIps`，见蓝图 §9 第 6 条。）
    'x-forwarded-for': randomIp(),
    ...(opts.headers ?? {}),
  }
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let body: Envelope<T>
  try {
    body = JSON.parse(text) as Envelope<T>
  } catch {
    body = { code: -1, message: `响应不是 JSON：${text.slice(0, 500)}`, data: undefined as T }
  }
  const reqLine = `${method} ${path}${opts.body === undefined ? '' : ` ${JSON.stringify(opts.body)}`}`
  return {
    status: res.status,
    body,
    detail: `\n  请求  ${reqLine}\n  响应  HTTP ${res.status} ${JSON.stringify(body)}`,
  }
}

let ipCounter = 0
function randomIp(): string {
  ipCounter += 1
  return `10.${(ipCounter >> 16) & 0xff}.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`
}
