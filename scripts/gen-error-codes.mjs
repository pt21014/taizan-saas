#!/usr/bin/env node
/**
 * 生成 `docs/ERROR-CODES.md`：全仓 7 位错误码总表。
 *
 * 为什么要自动生成：错误码是四端（api / admin / platform / client / app-*）唯一的契约面。
 * 手写一张 Markdown 表，三个月后一定会与代码里的常量对不上——而对不上的表现不是报错，
 * 是前端按一张过时的表做分流（该跳登录的只弹了个 toast）。所以这张表由脚本从源码扫出来，
 * 并且 `--check` 在 CI 里守着：改了码却没重跑生成器，CI 红。
 *
 * 用法：
 *   node scripts/gen-error-codes.mjs            # 写入 docs/ERROR-CODES.md
 *   node scripts/gen-error-codes.mjs --check    # 只比对，不一致则非零退出（CI 用）
 *
 * 扫描范围（蓝图 §4.9）：
 *   1. `packages/contracts/src/error-codes.ts` 的 `ErrorCode` 内置表 —— 唯一的「已收编」真源；
 *   2. `packages/*&#47;src/**&#47;error*.ts` 里的常量表（`buildErrorCode(...)` 或包内 `code(http, seq)` 助手）；
 *   3. 任何调用了 `defineErrorCodes(...)` 的文件（业务预留段 20–89）。
 *
 * 扫不到的码（运行期现算、或散落在别处）在本文件的 {@link MANUAL_ENTRIES} 里手工登记，
 * 并在表里标「待收编」。手工登记项**必须**写清楚出处文件，否则等于又回到了手写表。
 * 传输层兜底码（`transportErrorCode(status)`）**不登记**：它按规则现算、状态码有几十个，
 * 枚举只会得到一张永远不全的表——文档里以规则的形式给出（见 {@link TRANSPORT_RULE_LINES}）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = join(ROOT, 'docs', 'ERROR-CODES.md')
const CONTRACTS_FILE = join(ROOT, 'packages', 'contracts', 'src', 'error-codes.ts')

/** 域段号 → 中文含义（蓝图 §4.9 的域段表，与 `ERROR_DOMAIN` 一一对应）。 */
const DOMAIN_LABEL = {
  10: '通用 / 参数',
  11: '认证与会话',
  12: '租户与隔离',
  13: 'RBAC（权限点 / 数据范围）',
  14: '计费与套餐',
  15: '配额与功能开关',
  16: '支付',
  17: '三方集成',
  18: '队列与任务',
  19: '平台运营',
  90: '系统内部',
}

/**
 * 手工登记项：脚本扫不到、但前端确实会收到的码。
 *
 * 每条都必须写 `source`（出处），`pending` 为 true 表示「尚未收编进 `@taizan/contracts`」。
 */
const MANUAL_ENTRIES = []

/**
 * 传输层兜底码的说明段：以**规则**而不是枚举出现在文档里。
 *
 * 这几个码由 `transportErrorCode(status)` 在运行期现算，没有静态常量可扫，
 * 也不该有——把 401/403/404/413/415/… 逐个登记成常量，得到的是一张永远缺几行的表。
 */
const TRANSPORT_RULE_LINES = [
  '## 3. 传输层兜底码：按规则现算，不入表',
  '',
  '没有被任何业务码接管的 `HttpException`（守卫直接抛 `UnauthorizedException`、路由不存在、',
  'body-parser 报 413 ……）由 `@taizan/contracts` 的 `transportErrorCode(status)` 现算一个码：',
  '',
  '```ts',
  'transportErrorCode = (status: number) => buildErrorCode(ERROR_DOMAIN.COMMON, status, 0)',
  '// 401 → 1040100    403 → 1040300    404 → 1040400    413 → 1041300',
  '```',
  '',
  '即 **`10` 段 + HTTP 状态码 + 序号 `00`**。前端不需要为它特判：`httpSemantic()` 解出来就是原状态码。',
  '',
  '**这不是给业务用的**。要区分「未登录」与「登录已过期」，请主动抛 `1140100` / `1140101`——',
  '过滤器只看得见一个 401，猜不出是哪种。同理「租户不存在」请用 `1240400`，不要让它掉进 `1040400`：',
  '两者前端处理完全不同（一个是页面 404，一个要提示换店）。',
  '',
  '`1040000`（参数错误）与 `1042900`（请求过于频繁）在内置表里也各有一条同值常量——',
  '不是撞码，是同一个码的两种到达方式，语义一致，刻意保持相等。',
  '',
]

/** 读一个目录下的全部 `.ts`（递归），跳过 `dist` / `node_modules` / `.spec.ts`。 */
function listTsFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full))
      continue
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts') || entry.endsWith('.d.ts')) continue
    out.push(full)
  }
  return out
}

/** 从 `packages/contracts/src/error-codes.ts` 解析 `ERROR_DOMAIN` 常量表。 */
function parseDomainMap(source) {
  const block = /export const ERROR_DOMAIN = \{([\s\S]*?)\n\} as const/.exec(source)
  if (block === null) {
    throw new Error('[gen-error-codes] 在 contracts 里找不到 ERROR_DOMAIN 常量表——解析器失效了')
  }
  const map = {}
  const re = /^\s*([A-Z_][A-Z0-9_]*)\s*:\s*(\d+)\s*,/gm
  let m
  while ((m = re.exec(block[1])) !== null) map[m[1]] = Number(m[2])
  if (Object.keys(map).length === 0) {
    throw new Error('[gen-error-codes] ERROR_DOMAIN 解析出 0 条——解析器失效了')
  }
  return map
}

/**
 * 「正则失效防假通过」哨兵：扫描器必须能从一段已知文本里扫出预期的三条码。
 *
 * 没有它的话，正则写坏（比如某次改成不匹配多行）会让整张表变空，
 * 而「扫不到东西」和「一个码都没有」在输出上长得一模一样。
 */
const SENTINEL_SOURCE = `
export const SENTINEL_ERROR_DOMAIN = 13
function code(http, seq) { return SENTINEL_ERROR_DOMAIN * 100_000 + http * 100 + seq }
export const SENTINEL_ERRORS = {
  /** 哨兵甲 */
  ALPHA: { code: buildErrorCode(ERROR_DOMAIN.AUTH, 401, 7), message: '哨兵甲' },
  BETA: {
    code: buildErrorCode(ERROR_DOMAIN.PAYMENT, 400, 9),
    message: '哨兵乙',
  },
  GAMMA: { code: code(403, 3), message: '哨兵丙' },
} as const
`

/** 解析一个文件里的全部错误码常量表条目。 */
function scanFile(source, domainMap, relPath, pkgName) {
  // 包内 `code(http, seq)` 助手绑定的域段，例如 wechat-open 的 `WECHAT_OPEN_ERROR_DOMAIN = 17`
  let localDomain = null
  const localDomainMatch = /const\s+[A-Z_][A-Z0-9_]*_ERROR_DOMAIN\s*=\s*(\d+)/.exec(source)
  if (localDomainMatch !== null) localDomain = Number(localDomainMatch[1])

  const entries = []
  // 条目形如 `KEY: { code: <expr>, message: '<中文>' ... }`，允许换行与前置 TSDoc。
  // `code:` 后面的表达式可能带逗号（`buildErrorCode(D, 403, 1)`），所以只能用惰性匹配到
  // 下一个 `, message:`，不能用 `[^,]+`——那样一条都扫不出来（哨兵就是为了拦这个）。
  const re =
    /(^|\n)[ \t]*([A-Z_][A-Z0-9_]*)\s*:\s*\{\s*code:\s*([\s\S]{1,120}?)\s*,\s*message:\s*'([^']*)'/g
  let m
  while ((m = re.exec(source)) !== null) {
    const [, , name, expr, message] = m
    const code = resolveCodeExpr(expr.trim(), domainMap, localDomain)
    if (code === null) continue
    entries.push({
      code,
      name,
      message,
      pkg: pkgName,
      file: relPath,
      table: findEnclosingTable(source, m.index),
      note: findDoc(source, m.index),
    })
  }
  return entries
}

/** 把 `code:` 后面的表达式算成一个 7 位数字；算不出来返回 null（不猜）。 */
function resolveCodeExpr(expr, domainMap, localDomain) {
  const built = /^buildErrorCode\(\s*ERROR_DOMAIN\.([A-Z_]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(
    expr,
  )
  if (built !== null) {
    const domain = domainMap[built[1]]
    if (domain === undefined) return null
    return domain * 100_000 + Number(built[2]) * 100 + Number(built[3])
  }
  const local = /^code\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(expr)
  if (local !== null && localDomain !== null) {
    return localDomain * 100_000 + Number(local[1]) * 100 + Number(local[2])
  }
  const literal = /^(\d{7})$/.exec(expr.replace(/_/g, ''))
  if (literal !== null) return Number(literal[1])
  return null
}

/** 往回找最近的 `export const XXX =`，作为这条码所属的表名。 */
function findEnclosingTable(source, index) {
  const before = source.slice(0, index)
  const matches = [...before.matchAll(/export const ([A-Za-z_][A-Za-z0-9_]*)\s*=/g)]
  return matches.length === 0 ? '(匿名表)' : matches[matches.length - 1][1]
}

/** 取紧邻条目上方的单行 TSDoc（`/** xxx *&#47;`）作为备注。 */
function findDoc(source, index) {
  const before = source.slice(0, index)
  const doc = /\/\*\*\s*([^*][^\n]*?)\s*\*\/\s*$/.exec(before)
  if (doc === null) return ''
  return doc[1].replace(/\s+/g, ' ').trim()
}

function httpSemantic(code) {
  return Math.floor((code % 100000) / 100)
}
function domainOf(code) {
  return Math.floor(code / 100000)
}

/** 收集全仓错误码。 */
function collect() {
  const contractsSource = readFileSync(CONTRACTS_FILE, 'utf8')
  const domainMap = parseDomainMap(contractsSource)

  // 哨兵：扫描器必须扫得出这三条，否则整张表的「零违规」不可信
  const sentinel = scanFile(SENTINEL_SOURCE, domainMap, '(sentinel)', '(sentinel)')
  const sentinelCodes = sentinel.map((e) => e.code).sort((a, b) => a - b)
  const expected = [1140107, 1340303, 1640009]
  if (sentinelCodes.join(',') !== expected.join(',')) {
    throw new Error(
      `[gen-error-codes] 哨兵失败：期望扫出 ${expected.join('/')}，实际 ${
        sentinelCodes.join('/') || '（一条都没扫到）'
      }。扫描正则已失效，生成的表不可信。`,
    )
  }

  const pkgsDir = join(ROOT, 'packages')
  const files = []
  for (const pkg of readdirSync(pkgsDir)) {
    const src = join(pkgsDir, pkg, 'src')
    if (!existsSync(src)) continue
    const pkgJson = join(pkgsDir, pkg, 'package.json')
    const pkgName = existsSync(pkgJson)
      ? JSON.parse(readFileSync(pkgJson, 'utf8')).name
      : `packages/${pkg}`
    for (const file of listTsFiles(src)) {
      const source = readFileSync(file, 'utf8')
      const base = file.split(/[\\/]/).pop()
      const isErrorFile = /^error/i.test(base) || base === 'error-codes.ts'
      const hasDefine = source.includes('defineErrorCodes(')
      if (!isErrorFile && !hasDefine) continue
      files.push({ file, source, pkgName })
    }
  }

  const entries = []
  for (const { file, source, pkgName } of files) {
    entries.push(...scanFile(source, domainMap, relative(ROOT, file).replace(/\\/g, '/'), pkgName))
  }
  for (const manual of MANUAL_ENTRIES) entries.push({ ...manual, table: '（手工登记）' })

  // 「已收编」= 出自 contracts 的 ErrorCode 内置表
  for (const e of entries) {
    if (e.pending === undefined) {
      e.pending = !(e.pkg === '@taizan/contracts' && e.table === 'ErrorCode')
    }
  }

  const seen = new Map()
  for (const e of entries) {
    const dup = seen.get(e.code)
    if (dup !== undefined && dup.file !== e.file) {
      throw new Error(
        `[gen-error-codes] 错误码 ${e.code} 在两处定义：${dup.file}:${dup.name} 与 ${e.file}:${e.name}。` +
          '两个包各写一遍同一个码，改一处就会漂。',
      )
    }
    seen.set(e.code, e)
  }

  entries.sort((a, b) => a.code - b.code || a.name.localeCompare(b.name))
  return { entries, domainMap }
}

function esc(s) {
  return String(s).replace(/\|/g, '\\|')
}

function render({ entries, domainMap }) {
  const byDomain = new Map()
  for (const e of entries) {
    const d = domainOf(e.code)
    if (!byDomain.has(d)) byDomain.set(d, [])
    byDomain.get(d).push(e)
  }
  const domains = [...byDomain.keys()].sort((a, b) => a - b)
  const pendingCount = entries.filter((e) => e.pending).length

  const lines = []
  lines.push('<!-- 本文件由 `node scripts/gen-error-codes.mjs` 生成，请勿手改。')
  lines.push('     改错误码请改源码里的常量表，然后重跑 `pnpm docs:error-codes`。')
  lines.push('     CI 跑 `pnpm docs:error-codes --check`，不同步就红。 -->')
  lines.push('')
  lines.push('# 错误码总表')
  lines.push('')
  lines.push(
    `全仓共 **${entries.length}** 个错误码，其中 **${pendingCount}** 个「待收编」（定义在各包内，尚未进 \`@taizan/contracts\` 的 \`ErrorCode\` 内置表）。`,
  )
  lines.push('')
  lines.push('## 1. 编码规则（蓝图 §4.9）')
  lines.push('')
  lines.push('7 位十进制：`DD HHH NN` = **域段 2 位 + HTTP 语义 3 位 + 序号 2 位**。')
  lines.push('')
  lines.push('```')
  lines.push('  1 4 4 0 3 0 1')
  lines.push('  └┬┘ └─┬─┘ └┬┘')
  lines.push('   │    │    └── 序号 01：这个域段里的第几个 403')
  lines.push('   │    └─────── HTTP 语义 403：前端「只提示不登出」')
  lines.push('   └──────────── 域段 14：计费与套餐')
  lines.push('```')
  lines.push('')
  lines.push('| 域段 | 含义 | 域段 | 含义 |')
  lines.push('|---|---|---|---|')
  const domainRows = Object.entries(DOMAIN_LABEL)
  for (let i = 0; i < domainRows.length; i += 2) {
    const a = domainRows[i]
    const b = domainRows[i + 1]
    lines.push(`| \`${a[0]}\` | ${a[1]} | ${b ? `\`${b[0]}\`` : ''} | ${b ? b[1] : ''} |`)
  }
  lines.push('')
  lines.push(
    '`20–89` 全段留给业务项目，用 `defineErrorCodes()` 注册（它会拒绝 20–89 以外的域段，框架与业务永不撞码）。',
  )
  lines.push('')
  lines.push('## 2. 前端判定：只有一行')
  lines.push('')
  lines.push('```ts')
  lines.push('const httpSemantic = (code: number) => Math.floor((code % 100000) / 100)')
  lines.push('')
  lines.push('switch (httpSemantic(code)) {')
  lines.push('  case 401: clearSession(); gotoLogin(); break   // 清态跳登录')
  lines.push('  case 403: toast(message); break                // 只提示，绝不登出')
  lines.push('  case 429: toast("请求过于频繁"); break')
  lines.push('  default:  toast(message)')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push(
    '**403 不能登出**：套餐到期（`1440301`）、配额超限（`1540301`）、无权限（`1340300`）都是 403，' +
      '把它们当成 401 处理会让商家在续费页上被反复踢出登录。',
  )
  lines.push('')
  lines.push(
    '**几个码刻意不合并**：`1440301`（去续费）/ `1540301`（升套餐或清理）/ `1540302`（套餐没含这个功能）/ ' +
      '`1340300`（找店主要权限）的下一步动作完全不同。合成一个笼统的「无权限」，商家只会来问客服。',
  )
  lines.push('')
  lines.push(...TRANSPORT_RULE_LINES)
  lines.push('## 4. 全表')
  lines.push('')
  lines.push(
    '「状态」列：`✅ 已收编` = 在 `@taizan/contracts` 的 `ErrorCode` 里，四端可直接 import；',
  )
  lines.push('`待收编` = 暂时定义在各包内，引用时从该包 import，**不要抄字面量**。')
  lines.push('')
  for (const d of domains) {
    lines.push(`### 域段 ${d} · ${DOMAIN_LABEL[d] ?? '（未登记域段）'}`)
    lines.push('')
    lines.push('| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |')
    lines.push('|---|---|---|---|---|---|')
    for (const e of byDomain.get(d)) {
      const table = e.table === '（手工登记）' ? '' : `${e.table}.`
      lines.push(
        `| \`${e.code}\` | ${httpSemantic(e.code)} | \`${table}${e.name}\` | ${esc(e.message)} | \`${e.pkg}\`<br/>${esc(e.file)} | ${e.pending ? '待收编' : '✅ 已收编'} |`,
      )
    }
    lines.push('')
    const notes = byDomain.get(d).filter((e) => e.note)
    if (notes.length > 0) {
      lines.push('<details><summary>本段各码的说明</summary>')
      lines.push('')
      for (const e of notes) lines.push(`- \`${e.code}\` **${e.name}** — ${esc(e.note)}`)
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }
  }

  const emptyDomains = Object.keys(DOMAIN_LABEL)
    .map(Number)
    .filter((d) => !byDomain.has(d))
  if (emptyDomains.length > 0) {
    lines.push('### 已登记但还没有码的域段')
    lines.push('')
    lines.push(
      emptyDomains.map((d) => `\`${d}\`（${DOMAIN_LABEL[d]}）`).join('、') +
        ' —— `ERROR_DOMAIN` 里已经占住号段，但目前一个码都没有。用到时直接往这个段里加，不要挪用别的段。',
    )
    lines.push('')
  }

  lines.push('## 5. 待收编清单')
  lines.push('')
  const pending = entries.filter((e) => e.pending)
  if (pending.length === 0) {
    lines.push(
      '**（空）** —— 全仓每一个错误码的定义都在 `packages/contracts/src/error-codes.ts` 的 `ErrorCode` 内置表里。' +
        '`@taizan/nest-rbac` 的 `RBAC_ERRORS`、`@taizan/payment-core` 的 `PAYMENT_ERROR`、' +
        '`@taizan/wechat-open` 的 `WechatOpenErrorCode` 都只是内置表条目的别名（`FOO: ErrorCode.BAR`），' +
        '不再各自 `buildErrorCode()` 一遍，所以也扫不出重复定义。',
    )
    lines.push('')
    lines.push(
      '往下加码请**只改内置表**：包内那三张别名表要加条目，也是先在 contracts 定义、再在别名表里指过去。',
    )
  } else {
    lines.push(
      '下列码的真源在各包内，`@taizan/contracts` 的 `ErrorCode` 表里还没有。' +
        '收编动作是把定义搬进 `packages/contracts/src/error-codes.ts`，原处改成 re-export——' +
        '**码值不变**，所以是 minor 而不是 major（见 `docs/RELEASE.md` §2）。',
    )
    lines.push('')
    lines.push('| 码 | 常量 | 出处 | 为什么还没收编 |')
    lines.push('|---|---|---|---|')
    for (const e of pending) {
      const why = e.why ?? '（未写明理由——不写理由的待收编项等于永远待着，请补上或直接收编）'
      lines.push(
        `| \`${e.code}\` | \`${e.name}\` | \`${esc(e.file)}\`${e.source ? `（\`${esc(e.source)}\`）` : ''} | ${why} |`,
      )
    }
  }
  lines.push('')
  lines.push('## 6. 业务项目怎么加自己的码')
  lines.push('')
  lines.push('```ts')
  lines.push("import { defineErrorCodes } from '@taizan/contracts'")
  lines.push('')
  lines.push('export const BizErrorCode = defineErrorCodes({')
  lines.push("  GOODS_SOLD_OUT:   { code: 2040001, message: '商品已售罄' },")
  lines.push("  GOODS_OFF_SHELF:  { code: 2040002, message: '商品已下架' },")
  lines.push('})')
  lines.push('```')
  lines.push('')
  lines.push('三条纪律：')
  lines.push('')
  lines.push(
    '1. **域段必须落在 20–89**，`defineErrorCodes()` 会在模块求值时就抛错（不是等到第一次用）；',
  )
  lines.push(
    '2. **HTTP 语义段要选对**：这一段决定前端行为，不是给人看的注释。业务上的「这个不让你干」写 403，别写 400；',
  )
  lines.push(
    '3. **同一件事只给一个码**，不同的事一定分开。判断标准是「用户的下一步动作是否相同」——不同就必须分开。',
  )
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(
    `本表由 \`scripts/gen-error-codes.mjs\` 扫描 \`packages/*/src\` 生成，扫不到的在脚本的 \`MANUAL_ENTRIES\` 里手工登记（当前 ${MANUAL_ENTRIES.length} 条）。` +
      '传输层兜底码按规则现算，刻意不登记。',
  )
  lines.push('')
  return lines.join('\n')
}

function main() {
  const check = process.argv.includes('--check')
  let content
  try {
    content = render(collect())
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    process.exit(1)
  }

  if (!check) {
    writeFileSync(OUT_FILE, content, 'utf8')
    console.log(`[gen-error-codes] 已写入 ${relative(ROOT, OUT_FILE)}`)
    return
  }

  if (!existsSync(OUT_FILE)) {
    console.error(
      `[gen-error-codes] ${relative(ROOT, OUT_FILE)} 不存在。跑 \`pnpm docs:error-codes\` 生成它。`,
    )
    process.exit(1)
  }
  const current = readFileSync(OUT_FILE, 'utf8')
  const norm = (s) => s.replace(/\r\n/g, '\n')
  if (norm(current) !== norm(content)) {
    const sha = (s) => createHash('sha256').update(norm(s)).digest('hex').slice(0, 12)
    console.error(
      `[gen-error-codes] ${relative(ROOT, OUT_FILE)} 与源码不同步：\n` +
        `  文件 sha256(12) = ${sha(current)}\n` +
        `  应为 sha256(12) = ${sha(content)}\n` +
        '  跑 `pnpm docs:error-codes` 重新生成，并把改动一起提交。',
    )
    process.exit(1)
  }
  console.log('[gen-error-codes] docs/ERROR-CODES.md 与源码同步 ✅')
}

main()
