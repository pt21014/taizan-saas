/**
 * 蓝图 §8 **spec 4**：业务模块源码里禁止字面量 `tenantId:` 出现在 `where` 上下文。
 *
 * 守的不变量：**「禁止手写 tenantId 过滤条件」**（knowledge CLAUDE.md 第 1 条）。
 *
 * 手写的问题不是「写了会错」——`where: { tenantId }` 写对了也照样工作。问题是
 * **漏写不会报错**：一旦形成「查询里要自己带 tenantId」的习惯，某天有人少写一个，
 * 那条查询就安静地返回全平台的数据，没有任何东西会告诉你。
 *
 * 规则是「一次都不许写」，因为「一次都没有」是可以被机器验证的，而「每次都记得写」不能。
 * 租户条件由 `@taizan/nest-prisma` 的隔离扩展用 `AND` 包裹注入，调用方覆盖不掉。
 *
 * ## 扫描范围
 *
 * `src/modules/{admin,client,example-goods}/**`——也就是**跑在租户上下文里**的那些模块。
 * `src/modules/platform/**` 与 `src/seed.ts` 不在范围内：它们在 raw 白名单里，
 * 本来就没有租户上下文可用，`tenantId` 在那里是**入参**而不是过滤条件（由 spec 3 看着）。
 *
 * ## 为什么只看 `where` 上下文
 *
 * `{ tenantId: tenant.id, name, slug }` 这种**返回给前端的 DTO** 里出现 `tenantId:` 是正常的
 * （一号多店的切换列表就要它）。危险的只有把它当**过滤条件**——那意味着有人在自己
 * 决定查哪家店。所以扫描器要认得出 `where` 块的边界，而不是无脑 grep 关键字。
 */

import { describe, expect, it } from 'vitest'

import { balancedBlock, blankCommentsAndStrings, lineOf, readSources, SRC_DIR } from './_helpers'
import { join } from 'node:path'

/** 受管辖的业务模块目录（相对 `apps/api/`）。 */
const SCANNED_PREFIXES = [
  'src/modules/admin/',
  'src/modules/client/',
  'src/modules/example-goods/',
] as const

/** 一处违规。 */
interface Violation {
  file: string
  line: number
  snippet: string
}

/**
 * 「`where` 里出现了 tenantId 这个键」的判据。
 *
 * 三件事都要覆盖，缺一个就有绕过的写法：
 * - `{ tenantId: x }`  显式键值；
 * - `{ tenantId }`     **简写属性**——最常见的写法，也最容易被只查冒号的正则漏掉；
 * - 排除 `{ id: tenantId }`：那是拿一个**恰好叫 tenantId 的变量**当值，键是 `id`，合法；
 * - 排除 `r.tenantId`：属性访问不是键（`where: { id: { in: rows.map(r => r.tenantId) } }` 合法）。
 *
 * 判据因此是「前面是 `{` 或 `,`」+「后面是 `:` / `,` / `}`」——只有对象键的位置才同时满足。
 */
const MANUAL_TENANT_KEY = /[{,]\s*tenantId\s*(?::|,|\})/

/** `where` 后面紧跟的那个对象字面量的 `[start, end)`；找不到返回 `null`。 */
function whereBlockAfter(code: string, whereIndex: number): [number, number] | null {
  // 跳过 `where` 与冒号之间的空白，再跳到 `{`。
  let i = whereIndex + 'where'.length
  while (i < code.length && /\s/.test(code[i] ?? '')) i += 1
  if (code[i] !== ':') return null
  i += 1
  while (i < code.length && /\s/.test(code[i] ?? '')) i += 1
  if (code[i] !== '{') return null
  return [i, balancedBlock(code, i)]
}

/** 扫一批源码里「`where` 块内出现字面量 `tenantId:`」的位置。 */
export function scanManualTenantFilters(
  files: readonly { path: string; source: string }[],
): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    const code = blankCommentsAndStrings(file.source)
    for (const match of code.matchAll(/\bwhere\b/g)) {
      const block = whereBlockAfter(code, match.index ?? 0)
      if (!block) continue
      const [start, end] = block
      const body = code.slice(start, end)
      MANUAL_TENANT_KEY.lastIndex = 0
      const hit = MANUAL_TENANT_KEY.exec(body)
      if (!hit) continue
      // 报 `tenantId` 那个词的位置，而不是匹配串开头（开头是前一行末尾的逗号）。
      const line = lineOf(code, start + hit.index + hit[0].indexOf('tenantId'))
      violations.push({
        file: file.path,
        line,
        snippet: (file.source.split('\n')[line - 1] ?? '').trim(),
      })
    }
  }
  return violations
}

const files = readSources(SRC_DIR, (path) => SCANNED_PREFIXES.some((p) => path.startsWith(p)))

describe('spec 4：业务模块里不许手写 tenantId 过滤条件', () => {
  it('哨兵：扫描器认得出真违规，也不会误伤合法写法', () => {
    const bad = [
      { path: 'bad.ts', source: `await prisma.goods.findMany({ where: { tenantId, status } })` },
      {
        path: 'bad2.ts',
        source: `const row = await prisma.goods.findFirst({\n  where: {\n    id,\n    tenantId: ctx.tenantId,\n  },\n})`,
      },
    ]
    const good = [
      // 返回给前端的 DTO 里出现 tenantId 是正常的。
      { path: 'ok1.ts', source: `return shops.map((s) => ({ tenantId: s.id, name: s.name }))` },
      // select 里选 tenantId 是读，不是过滤。
      { path: 'ok2.ts', source: `findFirst({ where: { id }, select: { tenantId: true } })` },
      // 注释里的反例不该被当真。
      {
        path: 'ok3.ts',
        source: `// 反面教材：where: { tenantId: '别人家' }\nfindMany({ where: { id } })`,
      },
      // 变量名里含 tenantId 但不是 key。
      {
        path: 'ok4.ts',
        source: `findMany({ where: { id: { in: rows.map((r) => r.tenantId) } } })`,
      },
    ]

    const badHits = scanManualTenantFilters(bad)
    expect(badHits.map((v) => v.file)).toEqual(['bad.ts', 'bad2.ts'])
    expect(badHits[1]?.line, '报的行号要指到 tenantId 那一行，不是 where 那一行').toBe(4)

    expect(scanManualTenantFilters(good), '这四种写法都是合法的，扫描器不该误伤').toEqual([])
  })

  it('真的扫到了业务模块的源码', () => {
    expect(files.length).toBeGreaterThan(8)
    // 目录改名之后 `files` 会变成空数组，而空数组让下面那条断言恒真。
    for (const prefix of SCANNED_PREFIXES) {
      expect(
        files.some((f) => f.path.startsWith(prefix)),
        `${prefix} 下一个文件都没扫到，目录改名了？`,
      ).toBe(true)
    }
  })

  it(`${SCANNED_PREFIXES.join('、')} 下零违规`, () => {
    const violations = scanManualTenantFilters(files)
    expect(
      violations.map((v) => `${v.file}:${v.line}  ${v.snippet}`),
      '这些位置在 where 里手写了 tenantId。租户条件由隔离扩展注入，业务代码一次都不该写——\n' +
        '「一次都没有」可以被机器验证，「每次都记得写」不能。\n' +
        '确实需要跨租户的（登录找账号、平台后台），请走 RawPrismaService 并登记到 raw-reasons.ts。',
    ).toEqual([])
  })

  it('平台模块不在管辖范围内（它由 spec 3 的 raw 白名单看着）', () => {
    const platform = readSources(join(SRC_DIR, 'modules', 'platform'))
    expect(platform.length, '平台模块的源码没扫到，目录改名了？').toBeGreaterThan(0)
    // 范围划分弄反了（把 platform 也纳进来）时这条会红。
    expect(files.filter((f) => f.path.startsWith('src/modules/platform/'))).toEqual([])
  })
})
