/**
 * 蓝图 §9「knowledge `CLAUDE.md` 8 条不变量」第 8 条点名的「统一响应包」spec。
 *
 * `docs/SECURITY-INVARIANTS.md` 第 6 节的待补清单第 3 条一直写着「蓝图点名的那个文件名
 * 从未落地」——这份文件补上它。两条静态断言，都是「正则/AST 都不跑，只看字符串结构」的
 * 那一类，同 `raw-usage.spec.ts` / `ip-source.spec.ts` 的取舍。
 *
 * ## ① 控制器不许绕过信封
 *
 * 全仓（`apps/api/src` + 全部框架包 `packages/*\/src`）的 `*.controller.ts` 里，
 * 不许出现直接的 `res.json(` / `res.send(`——那绕过了 `TransformInterceptor` 套的
 * `{code,message,data}` 信封。唯二允许：
 *
 * - 那一路由方法头上贴了 `@RawResponse()`（蓝图 §4.9 定义的逃生口，健康检查、文件下载
 *   走这条）；
 * - 文件在 {@link FILE_WHITELIST} 里——目前只有 `packages/nest-payment/src/notify.controller.ts`
 *   一条：支付回调读的是应答报文顶层字段，套上信封微信会读到顶层 `code` 是数字 `0`，
 *   判定失败后持续重投（knowledge 真实事故：重推了 8 小时）。该文件实际上通过
 *   `@RawResponse()` + `res.status(...)`（不调 `.json`/`.send`）已经合规，白名单只是
 *   按任务要求把「这份文件例外」的理由写成一等公民，而不是让人看代码猜。
 *
 * ## ② `BizException` 第一个参数不许是裸数字字面量
 *
 * `apps/api/src` 里每一处 `throw new BizException(` 的第一个参数，必须是
 * `ErrorCode.XXX`（`@taizan/contracts` 内置表）或某个可追溯的命名引用（`defineErrorCodes`
 * 产物、或包一层的别名表，例如 `packages/nest-rbac` 的 `RBAC_ERRORS.FORBIDDEN`），
 * 不许写 `throw new BizException(1340300, ...)` 这种裸码——错一位数字没有任何编译期或
 * 运行期信号，只有真的走到这条分支才会发现返回码不对。
 *
 * ## 哨兵
 *
 * 两条规则都先在写死答案的样本上跑一遍：正则/字符串扫描失效时「没扫到东西」和
 * 「代码全部合规」在断言上长得一模一样，同 spec 1 / spec 13 用过的招数。
 *
 * @packageDocumentation
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { APP_ROOT, SRC_DIR, blankCommentsAndStrings, lineOf, readSources } from './_helpers'

const REPO_ROOT = resolve(APP_ROOT, '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/** 一份待扫的源码。 */
interface ScannedFile {
  /** 相对仓库根的 POSIX 路径，报错信息与白名单都按这个比对。 */
  path: string
  source: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 收集文件：apps/api/src 全部 + 全部框架包的 src（同 ip-source.spec.ts 的做法）
// ─────────────────────────────────────────────────────────────────────────────

/** 递归收集一个目录下会跑在生产流量上的 `.ts`（跳过 `.spec.ts` / `.d.ts`）。 */
function collect(dir: string, root: string): ScannedFile[] {
  const out: ScannedFile[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry)
      const stat = statSync(absolute)
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue
        walk(absolute)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      if (entry.endsWith('.d.ts') || entry.endsWith('.spec.ts')) continue
      const path = absolute
        .slice(root.length + 1)
        .split('\\')
        .join('/')
      out.push({ path, source: readFileSync(absolute, 'utf8') })
    }
  }
  walk(dir)
  return out
}

/** `packages/*\/src`，每个包各自的源码目录。 */
function collectAllPackageSrc(): ScannedFile[] {
  const out: ScannedFile[] = []
  // 生成器改写：业务项目里没有 `packages/`（框架包是从 npm 装的），
  // 这一侧退化成空集合。框架仓库里它照常扫。
  if (!existsSync(PACKAGES_DIR)) return out
  for (const name of readdirSync(PACKAGES_DIR)) {
    const pkgDir = join(PACKAGES_DIR, name)
    if (!statSync(pkgDir).isDirectory()) continue
    const src = join(pkgDir, 'src')
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    out.push(...collect(src, REPO_ROOT))
  }
  return out
}

const allRepoFiles: ScannedFile[] = [...collect(SRC_DIR, REPO_ROOT), ...collectAllPackageSrc()]

const controllerFiles = allRepoFiles.filter((f) => f.path.endsWith('.controller.ts'))

const appSourceFiles = readSources(SRC_DIR).map((f) => ({
  path: `apps/api/${f.path}`,
  source: f.source,
}))

// ─────────────────────────────────────────────────────────────────────────────
// ① res.json( / res.send( 绕过信封
// ─────────────────────────────────────────────────────────────────────────────

/** 一处疑似绕过信封的用法。 */
interface EnvelopeBypass {
  file: string
  line: number
  snippet: string
}

/**
 * 整份文件例外的白名单（不看 `@RawResponse()`，文件里任何一处 `res.json`/`res.send`
 * 都放行）。每一条必须写理由，且必须真实存在于扫描到的控制器列表里——写错路径的白名单
 * 等于没写。
 */
const FILE_WHITELIST: readonly { file: string; reason: string }[] = [
  {
    file: 'packages/nest-payment/src/notify.controller.ts',
    reason:
      '统一支付回调控制器（蓝图 §4.12）：微信等渠道读应答报文顶层字段，套上信封后顶层 code ' +
      '会变成数字 0，渠道判定失败并持续重投——knowledge 真实事故重推了 8 小时。' +
      '两条路由都已带 @RawResponse()，且实际走 res.status(...) + 返回体（不调 .json/.send），' +
      '这里整份文件豁免只是把「这份是回调控制器」的理由钉死，不靠人读代码猜。',
  },
]
const fileWhitelistSet = new Set(FILE_WHITELIST.map((w) => w.file))

/**
 * 扫一批文件里的 `res.json(` / `res.send(`，按「该方法头上有没有 `@RawResponse()`」
 * 与「文件是否在整份白名单里」判定是否放行。
 *
 * 判定「该方法头上有没有 `@RawResponse()`」的做法：把文件按 Nest 路由装饰器
 * （`@Get/@Post/@Put/@Patch/@Delete/@All`）切成若干段，一次命中落在哪一段里，
 * 就看那一段（从装饰器起、到匹配点为止）有没有出现过 `@RawResponse()`。
 * 命中点在第一个路由装饰器之前（罕见，例如类级方法）时，退化成「文件开头到命中点」。
 */
function scanEnvelopeBypass(
  files: readonly ScannedFile[],
  whitelist: ReadonlySet<string> = new Set(),
): EnvelopeBypass[] {
  const findings: EnvelopeBypass[] = []
  const ROUTE_DECORATOR = /@(?:Get|Post|Put|Patch|Delete|All)\s*\(/g
  // 允许链式调用（`res.status(x).json(y)`）：`res` 后面接零或多段 `.method(不含括号的参数)`，
  // 最后落到 `.json(`/`.send(`。中间调用的参数里出现嵌套括号会漏抓，但真实语料
  // （`res.status(cond ? a : b).json(v)`）没有这种写法。
  const CALL = /\bres\b(?:\s*\.\s*[A-Za-z_$][\w$]*\s*\([^()]*\))*\s*\.\s*(?:json|send)\s*\(/g

  for (const file of files) {
    if (whitelist.has(file.path)) continue
    const blanked = blankCommentsAndStrings(file.source)

    const decoratorStarts: number[] = []
    ROUTE_DECORATOR.lastIndex = 0
    let d: RegExpExecArray | null
    while ((d = ROUTE_DECORATOR.exec(blanked)) !== null) decoratorStarts.push(d.index)

    CALL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CALL.exec(blanked)) !== null) {
      const idx = m.index
      let segmentStart = 0
      for (const s of decoratorStarts) {
        if (s <= idx) segmentStart = s
        else break
      }
      const segment = blanked.slice(segmentStart, idx)
      if (segment.includes('@RawResponse()')) continue

      findings.push({
        file: file.path,
        line: lineOf(file.source, idx),
        snippet: file.source.slice(idx, idx + 40).split('\n')[0] ?? '',
      })
    }
  }
  return findings
}

/** {@link scanEnvelopeBypass} 的哨兵样本：一条该放行，一条该被抓。 */
const ENVELOPE_SENTINEL_FILES: readonly ScannedFile[] = [
  {
    path: 'sentinel/raw-response-ok.controller.ts',
    source: [
      '@Controller("t")',
      'class C {',
      '  @Get("ok")',
      '  @RawResponse()',
      '  ok(@Res() res: Response) {',
      '    res.status(200).json({ ok: true })',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    path: 'sentinel/bypass.controller.ts',
    source: [
      '@Controller("t")',
      'class C {',
      '  @Get("leak")',
      '  leak(@Res() res: Response) {',
      '    res.status(200).json({ leaked: true })',
      '  }',
      '}',
    ].join('\n'),
  },
]

describe('哨兵：res.json/res.send 扫描器还活着', () => {
  it('放行带 @RawResponse() 的路由，抓没带的', () => {
    const findings = scanEnvelopeBypass(ENVELOPE_SENTINEL_FILES)
    expect(findings.map((f) => f.file)).toEqual(['sentinel/bypass.controller.ts'])
    expect(findings[0]?.line).toBe(5)
  })

  it('整份文件白名单能豁免（否则下面真实扫描里 nest-payment 会被误抓）', () => {
    const findings = scanEnvelopeBypass(
      ENVELOPE_SENTINEL_FILES,
      new Set(['sentinel/bypass.controller.ts']),
    )
    expect(findings).toEqual([])
  })
})

describe('spec：全仓控制器不绕过信封', () => {
  it('确实扫到了控制器（否则下面的「零违规」是空转）', () => {
    // apps/api 19 个 + packages/nest-core、packages/nest-payment 各 1 个，见任务调查。
    expect(controllerFiles.length).toBeGreaterThanOrEqual(15)
  })

  it('白名单里的每一条都写了理由，且真的是被扫到的文件', () => {
    const known = new Set(controllerFiles.map((f) => f.path))
    for (const entry of FILE_WHITELIST) {
      expect(entry.reason.trim().length, `${entry.file} 的白名单理由为空`).toBeGreaterThan(10)
      // 生成器改写：白名单里指向 packages/ 的那几条在业务项目里扫不到（没有那个目录）。
      // 「理由必须写」这一半照常校验，「路径必须真实存在」那一半只对本项目内的文件校验——
      // 否则一条守着框架包的白名单会把业务项目的 pnpm test 拖红。
      if (entry.file.startsWith('packages/')) continue
      expect(known, `白名单里的 ${entry.file} 不在扫描到的控制器列表里——路径写错了`).toContain(
        entry.file,
      )
    }
  })

  it('零违规（@RawResponse() 路由与 nest-payment 回调控制器已豁免）', () => {
    const findings = scanEnvelopeBypass(controllerFiles, fileWhitelistSet)
    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.snippet}`),
      '直接 res.json(/res.send( 绕过了统一响应信封。要么给这条路由加 @RawResponse()' +
        '（并说明为什么这条必须原样输出），要么改回 return 数据让 TransformInterceptor 去包。',
    ).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ② BizException 第一个参数不许是裸数字字面量
// ─────────────────────────────────────────────────────────────────────────────

/** 一处疑似裸码的 `throw new BizException(...)`。 */
interface LiteralCodeFinding {
  file: string
  line: number
  arg: string
}

const THROW_BIZ = /throw\s+new\s+BizException\s*\(/g

/**
 * 从 `throw new BizException(` 的开括号之后找到第一个顶层参数的原文（遇到顶层逗号或
 * 与开括号配平的右括号为止），未配平时返回到文本末尾——同 `_helpers.ts` 的
 * `balancedBlock` 一个思路，只是这里不找 `{}`，找的是一个调用参数。
 */
function firstArgOf(source: string, openParenIndex: number): string {
  let depth = 0
  const start = openParenIndex + 1
  let i = start
  for (; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break // 配平的右括号，且是单参数调用
      depth -= 1
    } else if (ch === ',' && depth === 0) {
      break
    }
  }
  return source.slice(start, i).trim()
}

/** 裸数字字面量：以数字（可选前导 `-`）开头。`ErrorCode.XXX` / `FOO.code` 都不匹配。 */
const BARE_NUMBER = /^-?\d/

function scanBizExceptionLiteralCodes(files: readonly ScannedFile[]): LiteralCodeFinding[] {
  const findings: LiteralCodeFinding[] = []
  for (const file of files) {
    const blanked = blankCommentsAndStrings(file.source)
    THROW_BIZ.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = THROW_BIZ.exec(blanked)) !== null) {
      const openParen = m.index + m[0].length - 1
      const arg = firstArgOf(blanked, openParen)
      if (BARE_NUMBER.test(arg)) {
        findings.push({ file: file.path, line: lineOf(file.source, m.index), arg })
      }
    }
  }
  return findings
}

const BIZ_SENTINEL_FILES: readonly ScannedFile[] = [
  {
    path: 'sentinel/biz-ok.service.ts',
    source: [
      'class S {',
      '  m() {',
      "    throw new BizException(ErrorCode.BAD_REQUEST, '参数错误')",
      '  }',
      '  n() {',
      '    throw new BizException(AUTH_ERRORS.KIND_MISMATCH)',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    path: 'sentinel/biz-bad.service.ts',
    source: [
      'class S {',
      '  m() {',
      "    throw new BizException(1340300, '无权限')",
      '  }',
      '}',
    ].join('\n'),
  },
]

describe('哨兵：BizException 裸码扫描器还活着', () => {
  it('放行 ErrorCode.* 与别名引用，抓裸数字', () => {
    const findings = scanBizExceptionLiteralCodes(BIZ_SENTINEL_FILES)
    expect(findings).toEqual([{ file: 'sentinel/biz-bad.service.ts', line: 3, arg: '1340300' }])
  })
})

describe('spec：BizException 第一个参数不许是裸数字字面量', () => {
  it('确实扫到了 throw new BizException(（否则下面「零违规」是空转）', () => {
    const blanked = appSourceFiles.map((f) => blankCommentsAndStrings(f.source))
    const total = blanked.reduce(
      (n, s) => n + (s.match(/throw\s+new\s+BizException\s*\(/g) ?? []).length,
      0,
    )
    expect(total).toBeGreaterThan(30)
  })

  it('零违规', () => {
    const findings = scanBizExceptionLiteralCodes(appSourceFiles)
    expect(
      findings.map((f) => `${f.file}:${f.line} 第一个参数是裸码 ${f.arg}`),
      '改成 ErrorCode.XXX（@taizan/contracts 内置表）或一个可追溯的命名常量——' +
        '裸数字错一位没有任何编译期或运行期信号。',
    ).toEqual([])
  })
})
