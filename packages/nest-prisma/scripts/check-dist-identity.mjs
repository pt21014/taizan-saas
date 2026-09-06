#!/usr/bin/env node
/**
 * 构建产物的「跨入口同一引用」校验。照抄 `@taizan/nest-infra` 的方案与文件头注释。
 *
 * 背景：`tsup.config.ts` 有两个入口（`src/index.ts` 与 `src/testing/index.ts`）。
 * `splitting: false` 时两个入口各自打包，两边都直接 re-export 的模块会被分别复制进
 * 两份产物——消费方同时 `import '@taizan/nest-prisma'` 与
 * `import '@taizan/nest-prisma/testing'` 时，拿到的是两个不同的 class 引用。
 *
 * ## 本包现状（写这份脚本时核对过）：**两个入口的运行时导出零重叠**
 *
 * `testing/index.ts` 只从 `./fake-prisma-client` 重导出（`createFakePrisma` /
 * `modelOf` / 一堆类型），而 `fake-prisma-client.ts` 对 `../types` 的引用是纯
 * `import type`——编译后不留任何运行时依赖，`FakePrismaClient` 是完全自包含的手写替身，
 * 不复用主入口任何一行运行时代码。所以**今天**这个包并不会撞上 `splitting: false`
 * 那个 bug（没有共享代码可分裂）。
 *
 * 仍然把 `splitting` 改成 `true` 并配这份脚本，是为了：
 * 1. 与 `@taizan/nest-infra` / `@taizan/nest-auth` 保持同一套构建约定，往后谁在
 *    `testing/index.ts` 里加一行 `export { X } from '../xxx'`（哪怕只是手滑），
 *    只要 `X` 恰好也被主入口导出，这份脚本立刻能抓到「两份引用」这个问题——
 *    而不是等 `apps/api` 某个同时用两个入口的地方出现诡异的 `instanceof` 失败；
 * 2. 下面（1）的交集检查是**程序算出来的**，不是手抄列表：交集为空就直接说明「本包
 *    现在没有这个问题」，交集一旦非空，逐项做同一引用比对——列表不需要跟着源码改。
 *
 * 另外单独核对 `PRISMA_BASE_CLIENT` / `PRISMA_MODULE_OPTIONS`（Symbol.for 声明的
 * DI token）：`Symbol.for` 用的是进程级的全局符号注册表，键相同就一定拿到同一个
 * symbol——哪怕是分别来自 CJS 与 ESM 两份完全独立的产物。这条不是在测 `splitting`
 * （改不改它这条都成立），而是在测「token 真的用了 `Symbol.for` 而不是裸 `Symbol()`」
 * 这条更容易被悄悄改坏的约定（`tokens.ts` 文件头就是这么写的）。
 *
 * 不放进 `*.spec.ts`：这个脚本依赖 `dist/`，而 `typecheck` 在 `build` 之前跑，
 * 塞进 `src/` 会让它去解析一个还不存在的 `../dist/*` 路径。见 package.json 的
 * `test` 脚本：`vitest run` 之后才跑这个脚本。
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

/** 交集：两个模块的命名空间对象里，两边都有的 key。 */
function sharedKeys(main, testing) {
  return Object.keys(main).filter((k) => Object.prototype.hasOwnProperty.call(testing, k))
}

function checkSameReference(label, a, b) {
  if (a === b) {
    console.log(`  OK  ${label}（同一引用）`)
    return
  }
  failures.push(`${label}: 主入口与 testing 入口拿到的不是同一个引用`)
}

/** 主入口关键导出：DI 相关的类与 token，加上 `错误类`。 */
const MAIN_EXPORTS = [
  { name: 'PrismaModule', kind: 'function' },
  { name: 'PrismaService', kind: 'function' },
  { name: 'RawPrismaService', kind: 'function' },
  { name: 'DbHealthIndicator', kind: 'function' },
  { name: 'OptimisticLockError', kind: 'function' },
  { name: 'isOptimisticLockError', kind: 'function' },
  { name: 'PRISMA_BASE_CLIENT', kind: 'symbol' },
  { name: 'PRISMA_MODULE_OPTIONS', kind: 'symbol' },
]

/** testing 入口关键导出。 */
const TESTING_EXPORTS = [
  { name: 'createFakePrisma', kind: 'function' },
  { name: 'modelOf', kind: 'function' },
]

function checkExports(label, ns, list) {
  for (const { name, kind } of list) {
    const value = ns[name]
    if (value === undefined) {
      failures.push(`${label} ${name}: 没有这个导出（拼错了名字，还是被 splitting 拆丢了？）`)
      continue
    }
    if (typeof value !== kind) {
      failures.push(`${label} ${name}: 期望是 ${kind}，实际是 ${typeof value}`)
      continue
    }
    console.log(`  OK  ${label} ${name}（${kind}）`)
  }
}

async function checkCjs() {
  console.log('[check-dist-identity] CJS ...')
  const require = createRequire(import.meta.url)
  const main = require(path.join(distDir, 'index.cjs'))
  const testing = require(path.join(distDir, 'testing', 'index.cjs'))
  checkExports('cjs main', main, MAIN_EXPORTS)
  checkExports('cjs testing', testing, TESTING_EXPORTS)
  const shared = sharedKeys(main, testing)
  for (const name of shared) checkSameReference(`cjs ${name}`, main[name], testing[name])
  return { main, testing, shared }
}

async function checkEsm() {
  console.log('[check-dist-identity] ESM ...')
  const main = await import(pathToFileURL(path.join(distDir, 'index.js')).href)
  const testing = await import(pathToFileURL(path.join(distDir, 'testing', 'index.js')).href)
  checkExports('esm main', main, MAIN_EXPORTS)
  checkExports('esm testing', testing, TESTING_EXPORTS)
  const shared = sharedKeys(main, testing)
  for (const name of shared) checkSameReference(`esm ${name}`, main[name], testing[name])
  return { main, shared }
}

function checkSharedIntersectionIsDocumented(label, shared) {
  // 哨兵的反面：本包**现在**没有跨入口重叠导出（见文件头分析）。这条断言在文档与
  // 现实之间放一根绊线——哪天两个入口真的开始共享导出了，`shared.length` 会变成
  // 非零，这条断言会红，提醒维护者：文件头那段「零重叠」的分析已经过期，
  // 需要重新核对并在这里补上具体的引用比对（参照 `@taizan/nest-auth` 那份脚本）。
  if (shared.length > 0) {
    failures.push(
      `${label}: 两个入口出现了重叠导出 [${shared.join(', ')}]——本脚本文件头写的是` +
        '「零重叠」，请重新核对 testing/index.ts 是否新增了从生产代码 re-export 的符号，' +
        '并在这份脚本里补上对应的同引用断言。',
    )
    return
  }
  console.log(`  OK  ${label} 两个入口运行时导出确实零重叠（与文件头分析一致）`)
}

function checkGlobalSymbolRegistry(cjsMain, esmMain) {
  // Symbol.for 的语义：同一个 key 无论在哪个模块（CJS/ESM/不同产物）拿，
  // 都是进程级符号注册表里的同一个 symbol。这条失败说明 token 的声明从
  // `Symbol.for(...)` 被改成了裸 `Symbol(...)`——那样两份产物里的 token 会各自
  // 独立，同一个 PRISMA_BASE_CLIENT 在 CJS 装的 provider 用 ESM 那份 token 注入
  // 不到，症状是 Nest 报 `can't resolve dependencies`。
  for (const name of ['PRISMA_BASE_CLIENT', 'PRISMA_MODULE_OPTIONS']) {
    if (cjsMain[name] === esmMain[name]) {
      console.log(`  OK  ${name} 在 CJS 与 ESM 之间也是同一个 symbol（Symbol.for 注册表生效）`)
    } else {
      failures.push(
        `${name}: CJS 与 ESM 拿到的不是同一个 symbol，token 是不是被改成裸 Symbol() 了？`,
      )
    }
  }
}

const { main: cjsMain, shared: cjsShared } = await checkCjs()
const { main: esmMain, shared: esmShared } = await checkEsm()
checkSharedIntersectionIsDocumented('cjs', cjsShared)
checkSharedIntersectionIsDocumented('esm', esmShared)
checkGlobalSymbolRegistry(cjsMain, esmMain)

if (failures.length > 0) {
  console.error('\n[check-dist-identity] 失败：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log('\n[check-dist-identity] 全部通过。')
