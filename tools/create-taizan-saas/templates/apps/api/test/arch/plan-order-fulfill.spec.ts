/**
 * **T1-5 收口 spec**：把钱变成权益的代码只能有一份。
 *
 * 形状照抄蓝图 §8 spec 14（建租户的事务只允许出现在 `@taizan/provision` 的调用点），
 * 守的是同一类故障——**同一件事被写了两遍，然后两遍慢慢走偏**。
 *
 * 具体到收费闭环，两遍走偏长这样（xiaodian 的真实形态）：在线支付那条记得清
 * `PlatformGateway` 缓存、线下核销那条忘了，于是运营手工核销之后商家的后台还锁着；
 * 运营以为没生效再点一次，订单被兑现两次，到期日凭空多了一年。
 * 这一整条链路上**没有任何一步会报错**。
 *
 * ## 两条断言
 *
 * | # | 扫什么 | 只允许出现在 |
 * |---|---|---|
 * | 1 | `planExpireAt` 的**写入**（出现在 `data:` 块里） | `plan-order.service.ts` + 开通/播种白名单 |
 * | 2 | `PlanOrder` 的 `status: 'FULFILLED'` 写入 | `plan-order.service.ts` |
 *
 * ## 为什么只扫「写入」而不是所有出现
 *
 * `planExpireAt` 在 DTO、视图映射、闸门读取里到处都是，而那些**读**是完全正常的。
 * 一条分不清读写的规则会逼着大家给它加豁免，加到最后清单比规则长——那时候它就不守
 * 任何东西了。所以扫描器认 `data: { ... }` 块的边界（和 spec 4 认 `where` 块同一套
 * 做法），只有落库那一处会被抓。
 *
 * ## 白名单里为什么有「播种」——以及「开通」为什么已经不在里面了
 *
 * 建一家店的那一刻要把试用期写进 `planExpireAt`——那不是「兑现一笔订单」，
 * 是**这家店的第一天**，此时连一张 `PlanOrder` 都还不存在。seed 造演示数据同理。
 * 这是显式划界，不是漏网：它**只在 create 时写**，不改已有租户的到期日。
 *
 * T1-8 之后 `platform-tenant.service.ts` 从这份清单里**删掉了**：建店整块改走
 * `@taizan/provision` 的 `provisionTenant()`，那一处 `planExpireAt` 的写入已经进了
 * 包里（`packages/provision/src/provision.ts`），apps/api 侧一行都不剩。
 * 这条豁免不是「顺手清掉的」——本 spec 对白名单是双向对账的，留着它会被判 stale，
 * 因为一条没有对应写入点的豁免会让下一个人以为那处还有人在看。
 */

import { describe, expect, it } from 'vitest'

import { balancedBlock, blankCommentsAndStrings, lineOf, readSources, SRC_DIR } from './_helpers'

/** 唯一允许兑现（延长/回退到期日）的实现。 */
const FULFILL_SERVICE = 'src/modules/platform/plan-order/plan-order.service.ts'

/**
 * 允许写 `planExpireAt` 的其它位置，每条都要写清「为什么这里不是兑现」。
 *
 * 加一条 = 又开了一个能改到期日的地方，**必须当成一次架构决策来 review**。
 */
const EXPIRE_WRITE_ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'src/seed.ts',
    reason: 'seed 造演示租户，同上：建店那一刻的初始值，不是兑现。',
  },
]

const files = readSources(SRC_DIR)

/** 一处写入点。 */
interface Write {
  file: string
  line: number
  snippet: string
}

/**
 * 扫「`key` 出现在某个 `data:` 对象字面量里」的位置。
 *
 * 判据与 spec 4 的 `where` 扫描器同构：先定位 `data` 后面那个配平的 `{...}`，
 * 再在块内找对象键位置上的 `key`（前面是 `{` 或 `,`，后面是 `:`）。
 * 这样 `row.planExpireAt`（属性访问）、`planExpireAt: row.planExpireAt?.toISO...`
 * 这种视图映射（不在 data 块里）都不会被误伤。
 */
export function scanDataWrites(
  sources: readonly { path: string; source: string }[],
  key: string,
  valuePattern?: RegExp,
): Write[] {
  const keyPattern = new RegExp(`[{,]\\s*${key}\\s*:`)
  const out: Write[] = []
  for (const file of sources) {
    const code = blankCommentsAndStrings(file.source)
    for (const match of code.matchAll(/\bdata\b/g)) {
      const block = dataBlockAfter(code, match.index ?? 0)
      if (!block) continue
      const [start, end] = block
      const body = code.slice(start, end)
      const hit = keyPattern.exec(body)
      if (!hit) continue
      if (valuePattern) {
        // 字符串字面量已经被剥成空白了，所以值要回原文里取。
        const rawBody = file.source.slice(start, end)
        if (!valuePattern.test(rawBody)) continue
      }
      const line = lineOf(code, start + hit.index + hit[0].indexOf(key))
      if (out.some((w) => w.file === file.path && w.line === line)) continue
      out.push({
        file: file.path,
        line,
        snippet: (file.source.split('\n')[line - 1] ?? '').trim(),
      })
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/** `data` 后面紧跟的那个对象字面量的 `[start, end)`；不是对象字面量就返回 `null`。 */
function dataBlockAfter(code: string, dataIndex: number): [number, number] | null {
  let i = dataIndex + 'data'.length
  while (i < code.length && /\s/.test(code[i] ?? '')) i += 1
  if (code[i] !== ':') return null
  i += 1
  while (i < code.length && /\s/.test(code[i] ?? '')) i += 1
  if (code[i] !== '{') return null
  return [i, balancedBlock(code, i)]
}

const expireWrites = scanDataWrites(files, 'planExpireAt')
const fulfilledWrites = scanDataWrites(files, 'status', /status\s*:\s*'FULFILLED'/)

describe('T1-5：planExpireAt 的写入只能来自统一的 fulfill 路径', () => {
  it('哨兵：扫描器认得出真写入，也不误伤读取与视图映射', () => {
    const bad = [
      {
        path: 'bad.ts',
        source: `await tx.tenant.update({ where: { id }, data: { planExpireAt: expireAfterAt } })`,
      },
      {
        path: 'bad2.ts',
        source: `await prisma.tenant.create({\n  data: {\n    slug,\n    planExpireAt: trialEndAt,\n  },\n})`,
      },
    ]
    const good = [
      // 视图映射：读出来给前端，不是落库。
      {
        path: 'ok1.ts',
        source: `return { planExpireAt: row.planExpireAt?.toISOString() ?? null }`,
      },
      // 闸门读取。
      {
        path: 'ok2.ts',
        source: `const gate = evaluateTenantGate({ planExpireAt: view.planExpireAt })`,
      },
      // select 里选它是读。
      { path: 'ok3.ts', source: `findUnique({ where: { id }, select: { planExpireAt: true } })` },
      // 注释里举反例必须能自由地写。
      {
        path: 'ok4.ts',
        source: `// 反面教材：data: { planExpireAt: x }\nupdate({ data: { name } })`,
      },
    ]
    expect(scanDataWrites(bad, 'planExpireAt').map((w) => w.file)).toHaveLength(2)
    expect(scanDataWrites(good, 'planExpireAt')).toEqual([])
  })

  it('哨兵：FULFILLED 扫描器只认这一个字面量，PENDING/PAID 不算', () => {
    const bad = [{ path: 'b.ts', source: `update({ data: { status: 'FULFILLED', fulfilledAt } })` }]
    const good = [
      { path: 'g1.ts', source: `update({ data: { status: 'PAID', paidAt } })` },
      { path: 'g2.ts', source: `findMany({ where: { status: 'FULFILLED' } })` },
      { path: 'g3.ts', source: `count({ where: { status: { in: ['FULFILLED', 'REFUNDED'] } } })` },
    ]
    expect(scanDataWrites(bad, 'status', /status\s*:\s*'FULFILLED'/)).toHaveLength(1)
    expect(scanDataWrites(good, 'status', /status\s*:\s*'FULFILLED'/)).toEqual([])
  })

  it('真的扫到了源码与写入点（一个都没扫到会让下面全绿）', () => {
    expect(files.length).toBeGreaterThan(20)
    expect(expireWrites.length).toBeGreaterThan(0)
    expect(fulfilledWrites.length).toBeGreaterThan(0)
  })

  it('planExpireAt 的写入只在 plan-order.service.ts 与开通/播种白名单里', () => {
    const allowed = new Set<string>([FULFILL_SERVICE, ...EXPIRE_WRITE_ALLOWLIST.map((e) => e.path)])
    const outside = expireWrites.filter((w) => !allowed.has(w.file))
    expect(
      outside.map((w) => `${w.file}:${w.line}  ${w.snippet}`),
      '到期日被第二处代码改写 = 收费闭环有了第二份实现。两份会走偏（一份记得清闸门缓存、' +
        '一份忘了），而走偏之后没有任何一步会报错。请改调 PlanOrderService.fulfill()。',
    ).toEqual([])
  })

  it('fulfill / refund 两条写到期日的路径都真的在那个文件里（白名单不是把它整个豁免了）', () => {
    const inService = expireWrites.filter((w) => w.file === FULFILL_SERVICE)
    // 一处 fulfill（延长）、一处 refund（回退）。少一处说明有人把它挪出去了。
    expect(inService.length).toBeGreaterThanOrEqual(2)
  })

  it("PlanOrder 的 status: 'FULFILLED' 写入只在 plan-order.service.ts", () => {
    const outside = fulfilledWrites.filter((w) => w.file !== FULFILL_SERVICE)
    expect(
      outside.map((w) => `${w.file}:${w.line}  ${w.snippet}`),
      '直接把订单写成 FULFILLED = 绕过了状态机、绕过了租户延期、绕过了审计与站内信。' +
        '线下核销请调 markPaidOffline()，它就是 fulfill(..., via: "OFFLINE") 的薄包装。',
    ).toEqual([])
  })

  it('平台续期不再自己改到期日（T1-5 之前那份重复实现已经删干净）', () => {
    const tenantService = files.find(
      (f) => f.path === 'src/modules/platform/tenant/platform-tenant.service.ts',
    )
    expect(tenantService, '平台租户服务不见了？').toBeDefined()
    const code = blankCommentsAndStrings(tenantService?.source ?? '')
    // 续期方法体里不该再有 planOrder.create —— 那是 PlanOrderService.create 的活。
    expect(code).not.toMatch(/planOrder\s*\.\s*create/)
    expect(code).toMatch(/planOrders\s*\.\s*markPaidOffline/)
  })
})

describe('T1-5：白名单本身', () => {
  it('每条都有非空理由', () => {
    for (const entry of EXPIRE_WRITE_ALLOWLIST) {
      expect(entry.reason.trim().length, `${entry.path} 的理由是空的`).toBeGreaterThan(10)
    }
  })

  it('每条都真的被用到了（躺着一条没人用的豁免 = 一个忘了关的口子）', () => {
    const used = new Set(expireWrites.map((w) => w.file))
    const stale = EXPIRE_WRITE_ALLOWLIST.map((e) => e.path).filter((p) => !used.has(p))
    expect(stale, `这些豁免已经没有对应的写入点了，删掉它们：${stale.join(', ')}`).toEqual([])
  })
})
