#!/usr/bin/env node
/**
 * 构建产物的「跨入口同一引用」校验。
 *
 * 背景：`tsup.config.ts` 有两个入口（`src/index.ts` 与 `src/testing/index.ts`）。
 * 之前 `splitting: false`，两个入口各自打包，共享的模块（`MemoryQueueDriver`、
 * `scanClusterSafety`、`InfraModule` 以及它内部装配的 `QueueService` 等）被分别
 * 复制进两份产物——消费方同时 `import '@taizan/nest-infra'` 与
 * `import '@taizan/nest-infra/testing'` 时，拿到的是两个不同的 class 引用，
 * `instanceof` 与 Nest 的 class-token DI 匹配全部失效。
 *
 * 修法是把 `splitting` 改成 `true`：esbuild 会把「被 2 个及以上入口引用」的模块
 * 抽进一个共享 chunk，两个入口各自 `require`/`import` 同一份 chunk。这个脚本就是
 * 构建之后的回归断言——不放进 `*.spec.ts` 是因为它依赖 `dist/`，而 `tsc --noEmit`
 * （`typecheck` 脚本）在 `build` 之前跑，把它塞进 `src/` 会让 typecheck 去解析一个
 * 还不存在的 `../dist/*` 路径。见 package.json 的 `test` 脚本：`vitest run` 之后
 * 才跑这个脚本，跟顶层验收命令「build 先于 test」的顺序对得上。
 *
 * 用法：`node scripts/check-dist-identity.mjs`（需要先 `pnpm build`）。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const distDir = path.join(pkgRoot, 'dist')

if (!existsSync(distDir)) {
  console.error(
    '[check-dist-identity] dist/ 不存在——这个脚本检查的是构建产物，请先跑 `pnpm build`。',
  )
  process.exit(1)
}

const failures = []

function check(label, a, b) {
  if (a === undefined) {
    failures.push(`${label}: 主入口没有这个导出（拼错了名字？）`)
    return
  }
  if (b === undefined) {
    failures.push(`${label}: testing 入口没有这个导出（拼错了名字？）`)
    return
  }
  if (a !== b) {
    failures.push(`${label}: 主入口与 testing 入口拿到的不是同一个引用`)
    return
  }
  console.log(`  OK  ${label}`)
}

// 主入口与 testing 入口都直接导出、且底层实现被两个入口共享的符号。
// （`collectSourceFiles` / `createFakeInfraDb` / `createInfraTestApp` 是 testing
// 独有的，没有「跨入口同一引用」这个问题，不在这张表里。）
const SHARED_VALUE_EXPORTS = [
  'MemoryQueueDriver',
  'scanClusterSafety',
  'formatViolations',
  'ALLOW_MARKER',
  'DEFAULT_TIMER_ALLOWLIST',
  'PROCESS_LOCAL_MARKER',
]

async function checkCjs() {
  console.log('[check-dist-identity] CJS ...')
  const require = createRequire(import.meta.url)
  const main = require(path.join(distDir, 'index.cjs'))
  const testing = require(path.join(distDir, 'testing', 'index.cjs'))
  for (const name of SHARED_VALUE_EXPORTS) {
    check(`cjs ${name}`, main[name], testing[name])
  }
  return { main, testing }
}

async function checkEsm() {
  console.log('[check-dist-identity] ESM ...')
  const main = await import(pathToFileURL(path.join(distDir, 'index.js')).href)
  const testing = await import(pathToFileURL(path.join(distDir, 'testing', 'index.js')).href)
  for (const name of SHARED_VALUE_EXPORTS) {
    check(`esm ${name}`, main[name], testing[name])
  }
}

/**
 * 最贴近真实故障的断言：`testing/infra-test-kit.ts` 里的 `createInfraTestApp`
 * 用 `InfraModule.forRoot()` 装配出一个真实的 Nest 容器，容器内部用 `QueueService`
 * 类本身当 DI token 注册 provider。如果这个 `QueueService` 跟主入口导出的
 * `QueueService` 不是同一个类引用（split 前的 bug），下游代码
 * `constructor(private q: QueueService)`（从 `@taizan/nest-infra` import 的
 * `QueueService`）在这个容器里会直接解析失败——这正是 nest-notify 集成时踩到的坑。
 */
async function checkQueueServiceDiToken(main) {
  console.log('[check-dist-identity] Nest DI token（QueueService） ...')
  const testingKit = createRequire(import.meta.url)(path.join(distDir, 'testing', 'index.cjs'))
  const RedisMock = (await import('ioredis-mock')).default
  const app = await testingKit.createInfraTestApp({
    redis: new RedisMock(),
    cronEnabled: false,
    queueEnabled: false,
  })
  try {
    const resolved = app.get(main.QueueService)
    if (!(resolved instanceof main.QueueService)) {
      failures.push(
        'Nest DI: app.get(主入口的 QueueService) 拿到的实例不是主入口 QueueService 的实例——' +
          'InfraModule 内部装配用的是另一份 QueueService，DI token 对不上。',
      )
    } else {
      console.log('  OK  app.get(QueueService) instanceof 主入口 QueueService')
    }
  } finally {
    await app.close()
  }
}

const { main } = await checkCjs()
await checkEsm()
try {
  await checkQueueServiceDiToken(main)
} catch (err) {
  // 两个入口各打了一份 QueueService 时，Nest 的报错是
  // `UnknownElementException`——那本身就是本脚本要抓的那个 bug，
  // 别让它把进程直接崩掉、盖过上面已经收集到的其它失败项。
  failures.push(
    `Nest DI: 装配/解析 QueueService 抛了异常（很可能就是两份 QueueService 撞了）：` +
      `${err instanceof Error ? err.message : String(err)}`,
  )
}

if (failures.length > 0) {
  console.error('\n[check-dist-identity] 失败：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log('\n[check-dist-identity] 全部通过：两个入口共享同一份类/token 引用。')
