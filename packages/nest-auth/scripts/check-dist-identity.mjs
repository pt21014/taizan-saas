#!/usr/bin/env node
/**
 * 构建产物的「跨入口同一引用」校验。照抄 `@taizan/nest-infra` 的方案与文件头注释。
 *
 * 背景：`tsup.config.ts` 有两个入口（`src/index.ts` 与 `src/testing/index.ts`）。
 * `splitting: false` 时两个入口各自打包，两边都直接 re-export 的模块
 * （本包是 `InMemoryAuthRedis` / `takeOnce`（来自 `./redis`）与 `systemClock`
 * （来自 `./clock`））会被分别复制进两份产物——消费方同时
 * `import '@taizan/nest-auth'` 与 `import '@taizan/nest-auth/testing'` 时，
 * 拿到的是两个不同的 class/函数引用。
 *
 * 修法是把 `splitting` 改成 `true`：esbuild 把「被 2 个及以上入口引用」的模块抽进
 * 一个共享 chunk，两个入口各自 require/import 同一份 chunk。
 *
 * ## 这个脚本查两件事
 *
 * 1. **真正重叠的导出**（上面那三个）：主入口与 testing 入口必须拿到同一个引用。
 *    这份列表**不是手抄的**——脚本自己算 `Object.keys(main)` 与
 *    `Object.keys(testing)` 的交集，手抄列表会在两个入口的导出表分道扬镳之后
 *    悄悄过期（新增了重叠导出却忘了加进列表 = 少测一个）。
 * 2. **主入口独有的关键导出**（`GlobalAuthGuard` / `TokenService` / `AUTH_REDIS` /
 *    `RateLimitGuard` / 三个装饰器 metadata key 常量）：这些**不会**出现在 testing
 *    入口里（testing 只导出测试替身），没有「同一引用」可比——但 `splitting: true`
 *    仍然可能把它们错误地拆进被 testing 入口意外引用到的 chunk 里而在主入口丢失
 *    导出，所以这里退而求其次，断言它们在 CJS 与 ESM 两种格式下都存在、且形状对
 *    （类是函数、Symbol 常量是 symbol）。
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

/** 交集：两个模块的命名空间对象里，两边都有的 key（类型导出会被编译器抹掉，不会出现在这里）。 */
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

/** 主入口独有的、值得盯防的关键导出：类/守卫/Symbol 常量。 */
const MAIN_ONLY_EXPORTS = [
  { name: 'GlobalAuthGuard', kind: 'function' },
  { name: 'TokenService', kind: 'function' },
  { name: 'RateLimitGuard', kind: 'function' },
  { name: 'AUTH_REDIS', kind: 'symbol' },
  { name: 'RATE_LIMIT_KEY', kind: 'symbol-or-string' },
  { name: 'IS_PUBLIC_KEY', kind: 'symbol-or-string' },
  { name: 'AUTH_KINDS_KEY', kind: 'symbol-or-string' },
]

function checkMainOnlyExports(label, main) {
  for (const { name, kind } of MAIN_ONLY_EXPORTS) {
    const value = main[name]
    if (value === undefined) {
      failures.push(`${label} ${name}: 主入口没有这个导出（拼错了名字，还是被 splitting 拆丢了？）`)
      continue
    }
    const actual = typeof value
    const ok =
      kind === 'function'
        ? actual === 'function'
        : kind === 'symbol'
          ? actual === 'symbol'
          : actual === 'symbol' || actual === 'string' // metadata key 有的实现用字符串常量
    if (!ok) {
      failures.push(`${label} ${name}: 期望是 ${kind}，实际是 ${actual}`)
      continue
    }
    console.log(`  OK  ${label} ${name}（${actual}）`)
  }
}

async function checkCjs() {
  console.log('[check-dist-identity] CJS ...')
  const require = createRequire(import.meta.url)
  const main = require(path.join(distDir, 'index.cjs'))
  const testing = require(path.join(distDir, 'testing', 'index.cjs'))
  const shared = sharedKeys(main, testing)
  for (const name of shared) checkSameReference(`cjs ${name}`, main[name], testing[name])
  checkMainOnlyExports('cjs', main)
  return { main, testing, shared }
}

async function checkEsm() {
  console.log('[check-dist-identity] ESM ...')
  const main = await import(pathToFileURL(path.join(distDir, 'index.js')).href)
  const testing = await import(pathToFileURL(path.join(distDir, 'testing', 'index.js')).href)
  const shared = sharedKeys(main, testing)
  for (const name of shared) checkSameReference(`esm ${name}`, main[name], testing[name])
  checkMainOnlyExports('esm', main)
  return { shared }
}

const EXPECTED_SHARED = ['InMemoryAuthRedis', 'takeOnce', 'systemClock']

function checkExpectedOverlap(label, shared) {
  // 哨兵：如果这三个名字有一天从两个入口的交集里消失了（比如 testing/index.ts
  // 改成不再 re-export `systemClock`），说明「两个入口共享同一份运行时代码」这个
  // 场景本身没了——那不是坏事，但这个脚本的核心断言（1）就会退化成空转，
  // 得有人注意到并去更新这份注释与下面这条断言，而不是让脚本悄悄一直绿。
  for (const name of EXPECTED_SHARED) {
    if (!shared.includes(name)) {
      failures.push(
        `${label}: 期望的重叠导出 ${name} 不在两个入口的交集里了——` +
          '要么是被移除了（更新本脚本的 EXPECTED_SHARED），要么是 splitting 又坏了。',
      )
    }
  }
  console.log(`  OK  ${label} 交集覆盖 ${EXPECTED_SHARED.join(' / ')}`)
}

const { shared: cjsShared } = await checkCjs()
const { shared: esmShared } = await checkEsm()
checkExpectedOverlap('cjs', cjsShared)
checkExpectedOverlap('esm', esmShared)

if (failures.length > 0) {
  console.error('\n[check-dist-identity] 失败：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log('\n[check-dist-identity] 全部通过：两个入口共享同一份类/token 引用。')
