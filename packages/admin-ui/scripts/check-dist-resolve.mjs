#!/usr/bin/env node
/**
 * T4-1：验证 `dist/` 产物在「真实 npm 安装」下能被 Node 解析，而不是只能在
 * workspace link + Vite 的开发环境里工作。
 *
 * 背景：`antd` 的 `package.json` 没有 `"exports"` 字段。这意味着：
 *   - Node 的 **CJS** `require()` 对子路径会像老式 CommonJS 那样自动尝试补
 *     `.js` / `.json` / `index.js` 等后缀；
 *   - Node 的 **ESM** `import()` 对子路径是**严格解析**，缺后缀直接
 *     `ERR_MODULE_NOT_FOUND`；
 *   - Vite 的依赖解析介于两者之间，会做扩展名探测，所以开发环境（Vite）和
 *     workspace link（tsup 把 antd 设为 external，dist 里原样保留 import
 *     specifier，由消费方的 bundler/运行时解析）都感觉不到问题。
 * 一旦某个前端包发布后按真实 npm 路径安装（不再是 workspace symlink），
 * dist 里任何一处「无后缀深路径 import」都会在 Node ESM 下炸掉。
 * `import zhCN from 'antd/locale/zh_CN'`（现已改成 `.js`）就是本次修的那处。
 *
 * 本脚本做两件事：
 *   1. 快速扫描：build 后的 dist/*.js|*.cjs 里所有 `antd` / `@ant-design/*`
 *      的深路径 import/require，逐个用当前 node_modules（pnpm 已经装好的那份）
 *      验证 CJS `require.resolve()` 与 ESM `import.meta.resolve()` 是否都能过——
 *      跑得快，适合日常在 `pnpm test` 里跑。
 *   2. 端到端验证（较慢，是本脚本存在的真正原因）：`npm pack` 本包 +
 *      三个 workspace 依赖（@taizan/contracts / rbac-core / tokens），在一个
 *      全新的临时目录里用**真实 `npm install`**（不是 workspace symlink）把它们
 *      连同 antd/react/react-dom/@ant-design/icons/axios/zustand/
 *      react-router-dom 这些 peerDependencies 装成普通的 npm 依赖，然后分别用
 *      `node --input-type=module -e "import('@taizan/admin-ui')"` 和
 *      `node -e "require('@taizan/admin-ui')"` 加载，两者都必须成功。
 *
 * 用法：
 *   node scripts/check-dist-resolve.mjs             # 完整跑（含端到端安装，联网）
 *   node scripts/check-dist-resolve.mjs --scan-only # 只跑第 1 步（离线，秒级）
 *   node scripts/check-dist-resolve.mjs --keep      # 端到端那步跑完不删临时目录
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO = dirname(dirname(PKG_ROOT))
const IS_WIN = process.platform === 'win32'

const args = process.argv.slice(2)
const SCAN_ONLY = args.includes('--scan-only')
const KEEP = args.includes('--keep')

let failed = false
function fail(msg) {
  failed = true
  console.error(`\u001b[31m✗ ${msg}\u001b[0m`)
}
function ok(msg) {
  console.log(`\u001b[32m✓ ${msg}\u001b[0m`)
}
function banner(text) {
  console.log(`\n\u001b[36m━━ ${text} ━━\u001b[0m`)
}

// ────────────────────────────────────────────────────────────────────────
// 1. build，保证 dist 是最新的
// ────────────────────────────────────────────────────────────────────────
banner('build（保证 dist 是最新的）')
{
  const r = spawnSync('pnpm', ['exec', 'tsup'], { cwd: PKG_ROOT, stdio: 'inherit', shell: IS_WIN })
  if (r.status !== 0) throw new Error('tsup build 失败')
}

// ────────────────────────────────────────────────────────────────────────
// 2. 扫描 dist 里所有 antd / @ant-design 的深路径 import/require
// ────────────────────────────────────────────────────────────────────────
banner('扫描 dist 里的 antd / @ant-design 深路径引用')

const DIST_FILES = [
  { file: join(PKG_ROOT, 'dist/index.js'), kind: 'esm' },
  { file: join(PKG_ROOT, 'dist/index.cjs'), kind: 'cjs' },
]

// 匹配 `from "antd/xxx"` / `from 'antd/xxx'`（ESM）与 `require("antd/xxx")`（CJS）。
// 只关心「深路径」（带子路径的），裸的 `antd` / `@ant-design/icons` 走包的
// main/exports 主入口，不受本问题影响。
const IMPORT_RE = /(?:from\s+|require\()\s*["']((?:antd|@ant-design\/[^/'"]+)\/[^'"]+)["']/g

const require_ = createRequire(join(PKG_ROOT, 'package.json'))

/** @type {{specifier:string, kind:string}[]} */
const deepImports = []
for (const { file, kind } of DIST_FILES) {
  if (!existsSync(file)) continue
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(IMPORT_RE)) {
    deepImports.push({ specifier: m[1], kind })
  }
}

if (deepImports.length === 0) {
  ok('dist 里没有 antd / @ant-design 的深路径 import/require（无需担心 T4-1 这一类问题）')
} else {
  const seen = new Set()
  for (const { specifier, kind } of deepImports) {
    const key = `${specifier}@${kind}`
    if (seen.has(key)) continue
    seen.add(key)

    // CJS require.resolve：模拟 Node CJS 的补后缀/目录 index 探测。
    let cjsOk = false
    let cjsErr = ''
    try {
      require_.resolve(specifier)
      cjsOk = true
    } catch (e) {
      cjsErr = e.message
    }

    // 真正的 ESM `import()`（不是 `import.meta.resolve()`——后者在这个 Node 版本上
    // 不会做文件存在性校验，缺后缀也会「resolve 成功」，测不出 T4-1 那种炸法，
    // 必须真的 import 一次才能复现 ERR_MODULE_NOT_FOUND）。
    let esmOk = false
    let esmErr = ''
    try {
      await import(specifier)
      esmOk = true
    } catch (e) {
      esmErr = e.message
    }

    if (cjsOk && esmOk) {
      ok(`${specifier}（来自 dist/index.${kind === 'esm' ? 'js' : 'cjs'}） CJS+ESM 均可解析`)
    } else {
      fail(
        `${specifier}（来自 dist/index.${kind === 'esm' ? 'js' : 'cjs'}）解析失败：` +
          `CJS ${cjsOk ? 'OK' : `FAIL(${cjsErr})`}，ESM ${esmOk ? 'OK' : `FAIL(${esmErr})`}`,
      )
    }
  }
}

if (SCAN_ONLY) {
  if (failed) process.exit(1)
  console.log('\n--scan-only：跳过端到端真实 npm 安装验证。')
  process.exit(0)
}

// ────────────────────────────────────────────────────────────────────────
// 3. 端到端：npm pack + 真实 npm install，验证 import() 与 require() 都能过
// ────────────────────────────────────────────────────────────────────────
banner('端到端：npm pack + 真实 npm install')

function toPosix(p) {
  return p.split('\\').join('/')
}

function readPkg(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

// admin-ui 在运行时依赖的 workspace 包（tsup 默认把 package.json 的
// `dependencies` 当 external，所以它们不会被打进 dist，得单独 pack 装上）。
const WORKSPACE_DEPS = ['contracts', 'rbac-core', 'tokens']

const work = mkdtempSync(join(tmpdir(), 'taizan-check-dist-resolve-'))
const tarballDir = join(work, 'tarballs')
const projectDir = join(work, 'project')
mkdirSync(tarballDir, { recursive: true })
mkdirSync(projectDir, { recursive: true })

try {
  const overrides = {}

  function packInto(dir, label) {
    console.log(`  packing ${label} ...`)
    const printed = execFileSync('npm', ['pack', '--pack-destination', tarballDir], {
      cwd: dir,
      encoding: 'utf8',
      shell: IS_WIN,
    })
    const tgz = printed.trim().split(/\r?\n/).pop().trim()
    const tgzAbs = join(tarballDir, tgz)
    if (!existsSync(tgzAbs)) throw new Error(`npm pack 没产出 tarball：${label} → ${tgzAbs}`)
    return tgzAbs
  }

  // @taizan/admin-ui 打出来的 package.json 里，@taizan/contracts 等三个包仍然写的是
  // `"workspace:*"`——那是仓库内的写法，真实 npm 完全不认识这个协议
  // （`EUNSUPPORTEDPROTOCOL`）。真正发布时它们会被 `pnpm publish` 换成真实版本号，
  // 但这里没有发布流程，所以借 npm 的顶层 `overrides` 字段把它们强制重定向到本地
  // tarball——`overrides` 不看子依赖自己声明的 range，只按包名替换，能穿透
  // `workspace:*` 这种 npm 读不懂的协议。
  for (const dep of WORKSPACE_DEPS) {
    const dir = join(REPO, 'packages', dep)
    const pkg = readPkg(dir)
    if (!existsSync(join(dir, 'dist'))) {
      throw new Error(`@taizan/${dep} 还没 build（没有 dist/），请先 pnpm -F @taizan/${dep} build`)
    }
    overrides[pkg.name] = `file:${toPosix(packInto(dir, pkg.name))}`
  }
  const adminUiPkg = readPkg(PKG_ROOT)
  const adminUiTarball = `file:${toPosix(packInto(PKG_ROOT, adminUiPkg.name))}`

  // peerDependencies 用 admin-ui devDependencies 里锁定的版本号（真实号码，不是
  // range），保证这次验证装的是我们平时开发/测试用的同一个 antd/react 版本。
  const peerVersions = {}
  for (const name of Object.keys(adminUiPkg.peerDependencies ?? {})) {
    const v = adminUiPkg.devDependencies?.[name]
    if (!v)
      throw new Error(`peerDependency ${name} 在 devDependencies 里找不到版本号，没法锁定安装`)
    peerVersions[name] = v
  }

  const projectPkg = {
    name: 'taizan-check-dist-resolve',
    version: '0.0.0',
    private: true,
    dependencies: { [adminUiPkg.name]: adminUiTarball, ...peerVersions },
    overrides,
  }
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify(projectPkg, null, 2))

  console.log('  npm install（真实 registry，装 antd/react/... 这几个 peer）...')
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: IS_WIN,
  })
  if (install.status !== 0) throw new Error('npm install 失败')

  // 组件目前没有在模块顶层碰 window/localStorage（已用 grep 核对过：都在函数体里），
  // 这里仍然垫一个最小 shim，防止以后有人不小心在顶层加了这类代码时，这个脚本给出
  // 的是「window is not defined」而不是真正想测的模块解析错误。
  const globalShim = `
    if (typeof globalThis.window === 'undefined') {
      globalThis.window = { location: {}, history: {} };
      globalThis.localStorage = { getItem(){return null}, setItem(){}, removeItem(){} };
    }
  `

  console.log('  node --input-type=module -e "import(\'@taizan/admin-ui\')" ...')
  const esmCheck = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `${globalShim}\nconst m = await import('@taizan/admin-ui'); if (typeof m.TaizanConfigProvider !== 'function') throw new Error('TaizanConfigProvider missing'); console.log('ESM_IMPORT_OK')`,
    ],
    { cwd: projectDir, encoding: 'utf8' },
  )
  if (esmCheck.status === 0 && esmCheck.stdout.includes('ESM_IMPORT_OK')) {
    ok("Node ESM `import('@taizan/admin-ui')` 成功")
  } else {
    fail(`Node ESM import 失败：\n${esmCheck.stdout}\n${esmCheck.stderr}`)
  }

  console.log('  node -e "require(\'@taizan/admin-ui\')" ...')
  const cjsCheck = spawnSync(
    'node',
    [
      '-e',
      `${globalShim}\nconst m = require('@taizan/admin-ui'); if (typeof m.TaizanConfigProvider !== 'function') throw new Error('TaizanConfigProvider missing'); console.log('CJS_REQUIRE_OK')`,
    ],
    { cwd: projectDir, encoding: 'utf8' },
  )
  if (cjsCheck.status === 0 && cjsCheck.stdout.includes('CJS_REQUIRE_OK')) {
    ok("Node CJS `require('@taizan/admin-ui')` 成功")
  } else {
    fail(`Node CJS require 失败：\n${cjsCheck.stdout}\n${cjsCheck.stderr}`)
  }
} finally {
  if (KEEP) {
    console.log(`\n--keep：临时目录保留在 ${work}`)
  } else {
    rmSync(work, { recursive: true, force: true })
  }
}

if (failed) {
  console.error('\n有检查项失败，见上方 ✗。')
  process.exit(1)
}
console.log('\n全部通过。')
