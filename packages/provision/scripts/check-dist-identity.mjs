#!/usr/bin/env node
/**
 * 构建产物的两条校验。照抄 `@taizan/nest-prisma`/`@taizan/nest-infra` 的方案与文件头注释，
 * 按本包的实际问题改写了第二条。
 *
 * 背景：`tsup.config.ts` 有两个入口（`src/index.ts` 与 `src/arch/index.ts`）。
 * `splitting: false` 时两个入口各自打包，两边都直接 re-export 的模块会被分别复制进
 * 两份产物——消费方同时 `import '@taizan/provision'` 与
 * `import '@taizan/provision/arch'` 时，拿到的会是两个不同的引用。
 *
 * ## 校验一：跨入口同一引用（交集程序算出来，不是手抄列表）
 *
 * `src/index.ts` 现在**不再**从 `src/arch/**` re-export 任何符号——这正是这次拆分
 * 要解决的问题本身：`arch/single-path.scan.ts` 顶层 `import { readdirSync } from
 * 'node:fs'`，混进浏览器可用的主入口会让 `vite dev` 原生 ESM 加载整页崩溃。
 * 所以**今天**两个入口运行时导出零重叠。仍然把交集检查写成程序化的（而不是跳过），
 * 是为了：往后谁在 `src/index.ts` 里手滑加一行 `export { X } from './arch'`
 * （哪怕 `X` 恰好也被 arch 入口导出），这份脚本立刻能抓到「两份引用」这个问题——
 * 交集为空就直接说明「本包现在没有这个问题」，交集一旦非空，逐项做同一引用比对，
 * 列表不需要跟着源码改。
 *
 * ## 校验二：主入口 dist 里不许出现 node 内置模块（这次拆分真正要守的东西）
 *
 * `apps/site` 之前被迫在构建期生成一份纯数据文件绕过 `vite dev` 崩页
 * （见该应用 README「关键坑」，现已改回直接 `import from '@taizan/provision'`）。
 * 拆分子入口只是**手段**，真正的验收条件是「主入口的构建产物本身不含浏览器打不开的
 * node 内置模块 import/require」。这条断言直接读 `dist/index.js`/`dist/index.cjs`
 * 的文本，比对 `import ... from 'node:fs'` / `require('fs')` 之类的字样——比
 * 「相信没人会在主入口里手滑 re-export arch」更硬。
 *
 * 不放进 `*.spec.ts`：这个脚本依赖 `dist/`，而 `typecheck` 在 `build` 之前跑，
 * 塞进 `src/` 会让它去解析一个还不存在的 `../dist/*` 路径。见 package.json 的
 * `test` 脚本：`vitest run` 之后才跑这个脚本。
 *
 * 用法：`node scripts/check-dist-identity.mjs`（需要先 `pnpm build`）。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
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
function sharedKeys(main, arch) {
  return Object.keys(main).filter((k) => Object.prototype.hasOwnProperty.call(arch, k))
}

function checkSameReference(label, a, b) {
  if (a === b) {
    console.log(`  OK  ${label}（同一引用）`)
    return
  }
  failures.push(`${label}: 主入口与 arch 入口拿到的不是同一个引用`)
}

/** 主入口关键导出：`provisionTenant` 一路的函数与错误类。 */
const MAIN_EXPORTS = [
  { name: 'provisionTenant', kind: 'function' },
  { name: 'buildProvisionAudit', kind: 'function' },
  { name: 'ProvisionError', kind: 'function' },
  { name: 'isProvisionError', kind: 'function' },
  { name: 'validateSlug', kind: 'function' },
  { name: 'normalizePhone', kind: 'function' },
  { name: 'assertOwnerPasswordPolicy', kind: 'function' },
  { name: 'isReservedSlug', kind: 'function' },
]

/** arch 入口关键导出。 */
const ARCH_EXPORTS = [
  { name: 'scanTenantCreateCalls', kind: 'function' },
  { name: 'readSourceFiles', kind: 'function' },
  { name: 'stripCommentsAndStrings', kind: 'function' },
  { name: 'SENTINEL_SOURCE', kind: 'string' },
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
  const arch = require(path.join(distDir, 'arch', 'index.cjs'))
  checkExports('cjs main', main, MAIN_EXPORTS)
  checkExports('cjs arch', arch, ARCH_EXPORTS)
  const shared = sharedKeys(main, arch)
  for (const name of shared) checkSameReference(`cjs ${name}`, main[name], arch[name])
  return { main, arch, shared }
}

async function checkEsm() {
  console.log('[check-dist-identity] ESM ...')
  const main = await import(pathToFileURL(path.join(distDir, 'index.js')).href)
  const arch = await import(pathToFileURL(path.join(distDir, 'arch', 'index.js')).href)
  checkExports('esm main', main, MAIN_EXPORTS)
  checkExports('esm arch', arch, ARCH_EXPORTS)
  const shared = sharedKeys(main, arch)
  for (const name of shared) checkSameReference(`esm ${name}`, main[name], arch[name])
  return { main, shared }
}

function checkSharedIntersectionIsDocumented(label, shared) {
  // 哨兵的反面：本包**现在**没有跨入口重叠导出（见文件头「校验一」）。这条断言在
  // 文档与现实之间放一根绊线——哪天两个入口真的开始共享导出了，`shared.length`
  // 会变成非零，这条断言会红，提醒维护者：文件头那段「零重叠」的分析已经过期，
  // 需要重新核对并在这里补上具体的引用比对。
  if (shared.length > 0) {
    failures.push(
      `${label}: 两个入口出现了重叠导出 [${shared.join(', ')}]——本脚本文件头写的是` +
        '「零重叠」，请重新核对 src/index.ts 是否新增了从 arch/ re-export 的符号，' +
        '并在这份脚本里补上对应的同引用断言。',
    )
    return
  }
  console.log(`  OK  ${label} 两个入口运行时导出确实零重叠（与文件头分析一致）`)
}

/**
 * `apps/site` 崩页的病根：主入口的构建产物里不许出现浏览器打不开的 node 内置模块
 * import/require。直接读文本比对，比「相信没人会在 `src/index.ts` 手滑 re-export
 * arch/」更硬——`src/index.ts` 今天确实没有这个问题，但 esbuild 打包结果是否
 * 「干净」应该由产物本身来验证，不是由源码审查来担保。
 */
const FORBIDDEN_PATTERNS = [
  { label: "import ... from 'node:fs'", re: /from\s+["']node:fs["']/ },
  { label: "import ... from 'node:path'", re: /from\s+["']node:path["']/ },
  { label: "import ... from 'fs'", re: /from\s+["']fs["']/ },
  { label: "import ... from 'path'", re: /from\s+["']path["']/ },
  { label: 'require("fs")', re: /require\(\s*["']fs["']\s*\)/ },
  { label: 'require("node:fs")', re: /require\(\s*["']node:fs["']\s*\)/ },
  { label: 'require("path")', re: /require\(\s*["']path["']\s*\)/ },
  { label: 'require("node:path")', re: /require\(\s*["']node:path["']\s*\)/ },
]

function checkNoNodeBuiltinsInMainEntry() {
  console.log('[check-dist-identity] 主入口 dist 无 node 内置模块 ...')
  for (const file of ['index.js', 'index.cjs']) {
    const full = path.join(distDir, file)
    if (!existsSync(full)) {
      failures.push(`${file}: 文件不存在，主入口构建产物缺失`)
      continue
    }
    const text = readFileSync(full, 'utf8')
    let dirty = false
    for (const { label, re } of FORBIDDEN_PATTERNS) {
      if (re.test(text)) {
        dirty = true
        failures.push(
          `dist/${file} 里出现了 ${label}——主入口是浏览器可用的纯规则入口，` +
            'node-only 的扫描器不许再混进来，去掉 src/index.ts 里对 arch/ 的 re-export。',
        )
      }
    }
    if (!dirty) console.log(`  OK  dist/${file} 不含 node:fs / node:path`)
  }
}

const { main: cjsMain, shared: cjsShared } = await checkCjs()
const { main: esmMain, shared: esmShared } = await checkEsm()
checkSharedIntersectionIsDocumented('cjs', cjsShared)
checkSharedIntersectionIsDocumented('esm', esmShared)
checkNoNodeBuiltinsInMainEntry()

// cjsMain / esmMain 目前只用于上面两次 checkExports，这里引用一下避免 lint 报未使用——
// 保留变量名是为了将来要加"跨 CJS/ESM 同一 Symbol.for"这类校验时（本包目前没有
// Symbol.for 声明的 token，不搬 nest-prisma 那条）容易挂上去。
void cjsMain
void esmMain

if (failures.length > 0) {
  console.error('\n[check-dist-identity] 失败：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log('\n[check-dist-identity] 全部通过。')
