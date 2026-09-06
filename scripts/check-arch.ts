#!/usr/bin/env tsx
/**
 * `scripts/check-arch.ts` —— T4-2：**证明架构守卫真的会红**。
 *
 * ## 为什么要有这个脚本
 *
 * `pnpm test:arch` 全绿只能说明「现在没有违规」，说明不了「有违规时会被抓住」。
 * 这两件事看起来一样，实际差着一个正则：扫描器的正则一旦失效，它会安静地扫出零违规，
 * 而套件依然全绿。各 spec 内部的哨兵（`SENTINEL_SOURCE`）守的是这一层，但哨兵喂的是
 * **手写的字符串**，不是真实的项目结构——路径过滤、目录遍历、白名单加载这一整条
 * 「从真实文件到判定函数」的链路，哨兵一步都没走。
 *
 * 所以这里换一种证明方式：**往一份真实的项目副本里注入真实的违规，看守卫红不红**。
 *
 * ## 四类违规（对应任务分解 T4-2 的验收条目）
 *
 * | # | 注入什么 | 该被哪条 spec 拦下 |
 * |---|---|---|
 * | ① | 一张带 `tenantId` 却没登记进 `TENANT_MODELS` 的表 | spec 1 `tenant-models.spec.ts` |
 * | ② | 一个既无 `@Auth()` 也无 `@Public()` 的控制器 | spec 5 `guard-default-deny.spec.ts` |
 * | ③ | 一个 `Decimal` 金额列 | spec 9（`index.spec.ts` 内实现） |
 * | ④ | 一个裸 `setInterval` 调度 | spec 12 `cluster-safe.spec.ts` |
 *
 * ## 为什么是「副本」而不是就地改
 *
 * 就地改真实的 `apps/api` 有两个不能接受的后果：脚本被 Ctrl-C 打断时会留下违规代码；
 * 以及同一时刻别的人/别的 agent 在同一棵树上工作会看到凭空出现的文件。
 *
 * 副本放在 `apps/api/.arch-probe/api`——**刻意放在 `apps/api` 里面**，而不是系统临时目录：
 * spec 们要 `import '@taizan/prisma-base'`，Node 的模块解析靠的是从文件位置逐级向上找
 * `node_modules`。放在 `apps/api` 内部，这一步自动就通了；放到 `%TEMP%` 就得手工造符号链接，
 * 而符号链接在 Windows 上要么要管理员权限，要么行为和 Linux 不一致——那是给 CI 埋雷。
 *
 * ## 用法
 *
 * ```
 * pnpm check:arch            # 四类全部被拦下才退出 0
 * pnpm check:arch --keep     # 保留副本目录，方便手工复现某一类
 * ```
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_ROOT = join(REPO_ROOT, 'apps', 'api')
const PROBE_DIR = join(API_ROOT, '.arch-probe')
const PROBE_API = join(PROBE_DIR, 'api')

const KEEP = process.argv.includes('--keep')

// ─────────────────────────────────────────────────────────────────────────────
// 注入定义
// ─────────────────────────────────────────────────────────────────────────────

/** 一类注入。 */
interface Injection {
  /** ①②③④，只用于输出。 */
  tag: string
  /** 中文标题。 */
  title: string
  /** 该被哪条 spec 拦下（相对副本根的路径）。 */
  spec: string
  /** 那条 spec 在蓝图 §8 里的编号。 */
  specNumber: number
  /** 干活：往副本里写违规，返回一个把副本恢复原状的函数。 */
  inject: () => () => void
  /**
   * 失败输出里必须出现的字样。
   *
   * 只断言「退出码非零」是不够的——副本坏了、依赖没装、语法写错，
   * 退出码同样非零，而那时候这个脚本会给出一个**完全错误的结论**（「守卫有效」）。
   * 所以还要确认红的是**那一条**。
   */
  expect: string[]
}

/** 往副本里的某个文件追加内容，返回恢复函数。 */
function appendTo(relative: string, content: string): () => void {
  const file = join(PROBE_API, relative)
  const original = readFileSync(file, 'utf8')
  writeFileSync(file, `${original}\n${content}\n`, 'utf8')
  return () => writeFileSync(file, original, 'utf8')
}

/** 往副本里新建一个文件，返回恢复函数。 */
function createFile(relative: string, content: string): () => void {
  const file = join(PROBE_API, relative)
  if (existsSync(file)) throw new Error(`注入目标已存在，换个名字：${relative}`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return () => rmSync(file, { force: true })
}

const INJECTIONS: readonly Injection[] = [
  {
    tag: '①',
    title: '漏登记租户表：一张带 tenantId 的新表没进 TENANT_MODELS',
    spec: 'test/arch/tenant-models.spec.ts',
    specNumber: 1,
    // 注意是**追加到已有片段**而不是新建一个 .prisma 文件：spec 1 里有一条
    // 「扫到的片段数必须是 10」的断言，新建文件会先撞上那一条，红的原因就变了。
    inject: () =>
      appendTo(
        'prisma/schema/10-business/10-goods.prisma',
        `
/// [arch-probe] 故意不登记进 TENANT_MODELS 的租户表。
model ArchProbeLeak {
  id        String   @id @db.VarChar(26)
  tenantId  String   @db.VarChar(26)
  note      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId, id])
}`,
      ),
    expect: ['ArchProbeLeak'],
  },
  {
    tag: '②',
    title: '新控制器无守卫：既没有 @Auth() 也没有 @Public()',
    spec: 'test/arch/guard-default-deny.spec.ts',
    specNumber: 5,
    inject: () =>
      createFile(
        'src/modules/example-goods/arch-probe.controller.ts',
        `import { Controller, Get } from '@nestjs/common'

/** [arch-probe] 故意什么身份都不声明的控制器。 */
@Controller('api/admin/arch-probe')
export class ArchProbeController {
  @Get('list')
  list(): { ok: boolean } {
    return { ok: true }
  }
}
`,
      ),
    expect: ['arch-probe.controller.ts', 'ArchProbeController'],
  },
  {
    tag: '③',
    title: '金额用 Decimal：schema 里加一个 Decimal 金额列',
    spec: 'test/arch/index.spec.ts',
    specNumber: 9,
    // 刻意**不带** tenantId：这一类要单独证明 spec 9 会红，带上 tenantId 会顺带
    // 惊动 spec 1，红的原因就混了。
    inject: () =>
      appendTo(
        'prisma/schema/10-business/10-goods.prisma',
        `
/// [arch-probe] 故意用 Decimal 存钱的表。
model ArchProbeInvoice {
  id          String   @id @db.VarChar(26)
  amountCents Decimal  @db.Decimal(12, 2)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}`,
      ),
    expect: ['ArchProbeInvoice', 'Decimal'],
  },
  {
    tag: '④',
    title: '裸 setInterval：绕过 @LeaderCron 的进程内调度',
    spec: 'test/arch/cluster-safe.spec.ts',
    specNumber: 12,
    inject: () =>
      createFile(
        'src/modules/example-goods/arch-probe.worker.ts',
        `import { Injectable } from '@nestjs/common'

/** [arch-probe] 故意用裸 setInterval 做周期任务（4 实例下会跑 4 遍）。 */
@Injectable()
export class ArchProbeWorker {
  start(): void {
    setInterval(() => this.tick(), 30000)
  }

  private tick(): void {
    // 什么都不做，形状才是重点。
  }
}
`,
      ),
    expect: ['arch-probe.worker.ts'],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// 副本
// ─────────────────────────────────────────────────────────────────────────────

/** 复制到副本里的东西。只拿 spec 真正会读的那几样，别把 migrations / dist 也拖进来。 */
const COPY_LIST: readonly string[] = ['src', 'prisma/schema', 'test/arch', 'vitest.config.ts']

function buildProbe(): void {
  rmSync(PROBE_DIR, { recursive: true, force: true })
  for (const item of COPY_LIST) {
    const from = join(API_ROOT, item)
    if (!existsSync(from)) throw new Error(`副本缺少必需的输入：apps/api/${item}`)
    const to = join(PROBE_API, item)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true })
  }
}

/** vitest 的入口脚本（跨平台：不用 .bin 下的 shim，那玩意在 Windows 上是 .CMD）。 */
function vitestEntry(): string {
  const require = createRequire(join(API_ROOT, 'noop.js'))
  const pkgPath = require.resolve('vitest/package.json')
  const bin = (require(pkgPath) as { bin: Record<string, string> | string }).bin
  const relative = typeof bin === 'string' ? bin : (bin.vitest as string)
  return resolve(dirname(pkgPath), relative)
}

const VITEST = vitestEntry()

/** 在副本里跑一份 spec，返回 `[退出码, 合并后的输出]`。 */
function runSpec(spec: string): [number, string] {
  const result = spawnSync(process.execPath, [VITEST, 'run', spec, '--reporter=default'], {
    cwd: PROBE_API,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 32 * 1024 * 1024,
  })
  return [result.status ?? -1, `${result.stdout ?? ''}${result.stderr ?? ''}`]
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

interface Outcome {
  injection: Injection
  ok: boolean
  detail: string
}

function main(): number {
  console.log('── check-arch：往真实项目副本里注入违规，验证架构守卫会红 ──\n')
  console.log(`副本目录：${PROBE_API}`)
  buildProbe()

  // 第 0 步：干净副本必须全绿。跳过这一步的话，「注入后红了」什么都证明不了——
  // 副本本身就是红的时候，四类注入会全部「通过」，而这个脚本会宣布一切正常。
  console.log('\n[0/4] 基线：干净副本上这四条 spec 必须全绿')
  for (const spec of new Set(INJECTIONS.map((i) => i.spec))) {
    const [code, out] = runSpec(spec)
    if (code !== 0) {
      console.error(`\n基线失败：干净副本上 ${spec} 就是红的。副本坏了，不是守卫坏了。\n`)
      console.error(out.split('\n').slice(-40).join('\n'))
      return 2
    }
    console.log(`      ✓ ${spec}`)
  }

  const outcomes: Outcome[] = []
  for (const [index, injection] of INJECTIONS.entries()) {
    console.log(`\n[${index + 1}/4] ${injection.tag} ${injection.title}`)
    console.log(`      期望被 spec ${injection.specNumber}（${injection.spec}）拦下`)
    const restore = injection.inject()
    try {
      const [code, out] = runSpec(injection.spec)
      if (code === 0) {
        outcomes.push({
          injection,
          ok: false,
          detail: '注入了违规，那条 spec 依然是绿的——这个守卫现在守不住任何东西。',
        })
        console.log('      ✗ 没被拦下（spec 退出码 0）')
        continue
      }
      const missing = injection.expect.filter((needle) => !out.includes(needle))
      if (missing.length > 0) {
        outcomes.push({
          injection,
          ok: false,
          detail:
            `spec 红了，但失败信息里找不到 ${missing.map((m) => `「${m}」`).join('、')}——` +
            '红的原因很可能不是这次注入。',
        })
        console.log('      ✗ 红得不对（失败信息里没有预期的字样）')
        console.log(out.split('\n').slice(-30).join('\n'))
        continue
      }
      const failedTests = [...out.matchAll(/^\s*(?:×|✗|FAIL)\s+(.*)$/gm)]
        .map((m) => (m[1] ?? '').trim())
        .filter((line) => line !== '')
      outcomes.push({
        injection,
        ok: true,
        detail: failedTests[0] ?? `${injection.spec} 非零退出`,
      })
      console.log(`      ✓ 被拦下：${failedTests.slice(0, 2).join(' / ') || '非零退出'}`)
    } finally {
      restore()
    }
  }

  console.log('\n── 结论 ──')
  for (const o of outcomes) {
    const mark = o.ok ? '拦下' : '漏放'
    console.log(
      `${o.injection.tag} ${mark}  spec ${String(o.injection.specNumber).padStart(2, '0')}  ` +
        `${o.injection.spec}\n     ${o.detail}`,
    )
  }

  const escaped = outcomes.filter((o) => !o.ok)
  if (escaped.length > 0) {
    console.error(
      `\n${escaped.length} / ${INJECTIONS.length} 类违规没有被拦下。` +
        '在补上守卫之前，`pnpm test:arch` 全绿不代表任何事情。',
    )
    return 1
  }
  console.log(`\n${INJECTIONS.length} / ${INJECTIONS.length} 类违规全部被拦下。守卫有效。`)
  return 0
}

let code = 1
try {
  code = main()
} catch (error) {
  console.error('check-arch 自身出错：', error)
  code = 2
} finally {
  if (KEEP) {
    console.log(`\n--keep：副本保留在 ${PROBE_API}`)
  } else {
    rmSync(PROBE_DIR, { recursive: true, force: true })
  }
}
process.exit(code)
