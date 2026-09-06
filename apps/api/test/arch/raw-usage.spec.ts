/**
 * 蓝图 §8 **spec 3**：`prisma.raw` / `RawPrismaService` 的使用点必须在允许清单里，
 * 且每处附近都要有 `// raw-reason:` 注释。
 *
 * 守的不变量：**逃生口不被滥用**。raw 句柄没有租户注入——它存在是因为确实有三类操作
 * 绕不开（登录跨租户找账号、支付回调定位租户、平台后台），但每多一处就多一个
 * 「这里本来该注入租户却没注入」的地方，而那种 bug 在测试里是看不出来的
 * （单租户库上跑什么都对）。
 *
 * 两个条件是**与**：
 * - 只写注释不进清单 → 清单形同虚设，谁都能就地写个理由把自己放行；
 * - 只进清单不写注释 → 半年后没人记得这一处当初为什么要 raw，重构时顺手就改错了。
 */

import { describe, expect, it } from 'vitest'

import { RAW_REASONS } from '../../src/tenancy/raw-reasons'
import { blankCommentsAndStrings, lineOf, readSources, SRC_DIR } from './_helpers'

/** 一处 raw 使用点。 */
interface RawUsage {
  file: string
  line: number
  snippet: string
}

/** 认得出来的 raw 用法。 */
const RAW_PATTERNS: readonly RegExp[] = [
  // `this.prisma.raw.xxx` / `prisma.raw.xxx`
  /\braw\s*\.\s*client\b/g,
  /\bprisma\s*\.\s*raw\b/g,
  // 注入 `RawPrismaService`（模块级、静态可见的依赖声明——这才是最好扫的形态）
  /\bRawPrismaService\b/g,
  // 物理删除逃生口
  /\bhardDelete(?:Many)?\s*\(/g,
  // 自己 new 一个客户端：**最彻底的绕过**——连软删和 ULID 扩展都没有。
  // 只有 seed / 一次性脚本可以这么干。
  /\bnew\s+PrismaClient\s*\(/g,
]

/**
 * `import` 行不算使用点。
 *
 * 一个类被 import 进来还什么都没干，要求它上面挂一条 raw-reason 只会逼着大家在
 * import 区堆注释——而真正该被解释的是**注入点**与**调用点**，那些行照样会被扫到。
 */
function isImportLine(text: string): boolean {
  return /^\s*(?:import|export)\b/.test(text) || /^\s*}?\s*from\s+['"]/.test(text)
}

/** 「附近」= 用点上方 12 行以内。装饰器 + 构造函数签名通常撑不过这个距离。 */
const REASON_LOOKBACK_LINES = 12

const files = readSources(SRC_DIR)

/** 扫出所有 raw 使用点（已剥掉注释与字符串，避免文档里的反例被当成真用法）。 */
function scanRawUsages(): RawUsage[] {
  const usages: RawUsage[] = []
  for (const file of files) {
    const code = blankCommentsAndStrings(file.source)
    for (const pattern of RAW_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of code.matchAll(pattern)) {
        const index = match.index ?? 0
        const line = lineOf(code, index)
        // 同一行可能被多条正则命中（`@Inject(RawPrismaService) raw: RawPrismaService`），去重。
        if (usages.some((u) => u.file === file.path && u.line === line)) continue
        const snippet = (file.source.split('\n')[line - 1] ?? '').trim()
        if (isImportLine(snippet)) continue
        usages.push({ file: file.path, line, snippet })
      }
    }
  }
  return usages.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/** 这个文件是否被清单覆盖（条目以 `/` 结尾表示整个目录）。 */
function allowedBy(path: string): string | undefined {
  return RAW_REASONS.find((entry) =>
    entry.path.endsWith('/') ? path.startsWith(entry.path) : path === entry.path,
  )?.path
}

/** 用点上方若干行内有没有 `// raw-reason:`。 */
function hasNearbyReason(source: string, line: number): boolean {
  const lines = source.split('\n')
  const from = Math.max(0, line - 1 - REASON_LOOKBACK_LINES)
  return lines.slice(from, line).some((text) => text.includes('raw-reason:'))
}

const usages = scanRawUsages()

describe('spec 3：raw 逃生口的使用点', () => {
  it('哨兵：扫描器确实认得出 raw 用法（扫不到会让下面每一条都假通过）', () => {
    const sentinel = `
      // raw-reason: 哨兵
      constructor(@Inject(RawPrismaService) private readonly raw: RawPrismaService) {}
      const x = await this.raw.client.tenant.findFirst({ where: { slug } })
      await this.prisma.raw.tenant.count()
      await svc.hardDelete('Goods', { where: { id } })
      const prisma = new PrismaClient()
    `
    const code = blankCommentsAndStrings(sentinel)
    const hits = RAW_PATTERNS.filter((p) => {
      p.lastIndex = 0
      return p.test(code)
    })
    expect(hits.length, '每一类 raw 用法的正则都必须命中哨兵').toBe(RAW_PATTERNS.length)
    // 也要证明「注释里的反例不算」——上面那行 `// raw-reason: 哨兵` 被剥成空白了。
    expect(code).not.toContain('哨兵')
  })

  it('真的扫到了 src 下的源码', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('确实存在 raw 使用点（一个都没有说明扫描器坏了，因为登录必然要用）', () => {
    expect(usages.length).toBeGreaterThan(0)
  })

  it('每处 raw 使用点都落在 RAW_REASONS 的清单里', () => {
    const outside = usages.filter((u) => allowedBy(u.file) === undefined)
    expect(
      outside.map((u) => `${u.file}:${u.line}  ${u.snippet}`),
      '这些位置在用 raw 句柄但不在 src/tenancy/raw-reasons.ts 的清单里。\n' +
        '新增一条清单 = 新开一个绕过租户隔离的口子，必须当成一次架构决策来 review，\n' +
        '而不是「先加上让测试过了再说」。',
    ).toEqual([])
  })

  it('每处 raw 使用点附近都有 // raw-reason: 注释', () => {
    const unexplained = usages.filter(
      (u) =>
        allowedBy(u.file) !== undefined &&
        !hasNearbyReason(files.find((f) => f.path === u.file)?.source ?? '', u.line),
    )
    expect(
      unexplained.map((u) => `${u.file}:${u.line}  ${u.snippet}`),
      `这些位置在清单内但上方 ${REASON_LOOKBACK_LINES} 行没有 // raw-reason: 注释。` +
        '半年后没人记得这一处为什么要绕过隔离，重构时顺手就改错了。',
    ).toEqual([])
  })
})

describe('RAW_REASONS 清单本身', () => {
  it('每条都有非空理由', () => {
    const empty = RAW_REASONS.filter((e) => e.reason.trim().length === 0).map((e) => e.path)
    expect(empty).toEqual([])
  })

  it('没有重复条目', () => {
    const paths = RAW_REASONS.map((e) => e.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('每条都真的被用到了（清单里躺着一条没人用的豁免 = 一个忘了关的口子）', () => {
    const used = new Set(usages.map((u) => allowedBy(u.file)))
    const stale = RAW_REASONS.map((e) => e.path).filter((p) => !used.has(p))
    expect(stale, `这些豁免已经没有对应的 raw 使用点了，删掉它们：${stale.join(', ')}`).toEqual([])
  })

  it('清单只覆盖三类合法用途', () => {
    for (const entry of RAW_REASONS) {
      expect(['login-cross-tenant', 'payment-callback', 'platform-console']).toContain(
        entry.category,
      )
    }
  })
})
