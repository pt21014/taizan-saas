/**
 * 蓝图 §8 **spec 8**：续费白名单 ↔ 真实控制器前缀 ↔ 套餐功能项，三方对账。
 *
 * 守的是同一个死循环的三侧：**「到期 → 后台只读 → 续不了费 → 永远到期」**，
 * 而平台恰恰是想收钱的那一方。
 *
 * | 方向 | 判定函数 | 出事的样子 |
 * |---|---|---|
 * | 白名单 → 控制器 | `verifyRenewalPrefixes`（nest-billing） | 白名单里写着 `/api/admin/billing`，实际控制器叫 `/api/admin/plan-order`。白名单放行的是一个不存在的路径 |
 * | 功能项 → 白名单 | `assertFeatureNotShadowingRenewal`（billing-rules） | 某个功能项的 `pathPrefixes` 盖住了续费路径。没买那个功能的商家永远续不了费 |
 * | 功能项 → 控制器 | 本文件 | 功能项的 `pathPrefixes` 指向一个不存在的控制器。闸门静默失效，接口照常通，而平台以为自己锁住了 |
 *
 * 第三条不在框架包里，因为「有哪些控制器」只有应用知道。它同样是**静默**故障：
 * 平台在套餐里把某个功能取消勾选，商家那边什么变化都没有。
 */

import { ALWAYS_WRITABLE_PREFIXES, assertFeatureNotShadowingRenewal } from '@taizan/billing-rules'
import { verifyRenewalPrefixes } from '@taizan/nest-billing'
import { describe, expect, it } from 'vitest'

import { FEATURES } from '../../src/registry/features'
import { readSources, SRC_DIR } from './_helpers'

/** 从所有控制器里抠出 `@Controller('...')` 的前缀（带前导斜杠）。 */
function controllerPrefixes(): string[] {
  const files = readSources(SRC_DIR, (path) => path.endsWith('.controller.ts'))
  const prefixes = new Set<string>()
  for (const file of files) {
    for (const match of file.source.matchAll(/@Controller\(\s*['"`]([^'"`]*)['"`]/g)) {
      const raw = match[1] ?? ''
      prefixes.add(raw.startsWith('/') ? raw : `/${raw}`)
    }
  }
  return [...prefixes].sort()
}

const prefixes = controllerPrefixes()
const report = verifyRenewalPrefixes(prefixes)

/** 一条功能项前缀有没有对应的控制器（前缀相等，或控制器落在它下面）。 */
function isCoveredByController(featurePrefix: string): boolean {
  const normalized = featurePrefix.endsWith('/') ? featurePrefix.slice(0, -1) : featurePrefix
  return prefixes.some((c) => c === normalized || c.startsWith(`${normalized}/`))
}

describe('spec 8：续费白名单与控制器前缀', () => {
  it('哨兵：判定函数本身没坏（给一组假前缀必须报出全部三条）', () => {
    const sentinel = verifyRenewalPrefixes(['/api/admin/goods', '/api/client/goods'])
    expect(sentinel.ok).toBe(false)
    expect(sentinel.violations.map((v) => v.prefix).sort()).toEqual([...ALWAYS_WRITABLE_PREFIXES])
  })

  it('哨兵：`/api/admin/bill` 不算兑现 `/api/admin/billing`（前缀要卡段边界）', () => {
    const sentinel = verifyRenewalPrefixes(['/api/admin/auth', '/api/admin/bill'])
    expect(sentinel.violations.map((v) => v.prefix)).toContain('/api/admin/billing')
  })

  it('真的扫到了控制器前缀（一个都没扫到会让下面全绿）', () => {
    expect(prefixes.length).toBeGreaterThanOrEqual(8)
    expect(prefixes.every((p) => p.startsWith('/api/'))).toBe(true)
  })

  it('白名单里的每一条都有真实控制器兑现', () => {
    expect(
      report.violations.map((v) => v.reason),
      '白名单放行的是一个不存在的路径 = 商家到期后找不到续费入口。',
    ).toEqual([])
  })

  it('每条白名单命中的控制器都列得出来（便于人工核对是不是命中了预期的那个）', () => {
    for (const prefix of ALWAYS_WRITABLE_PREFIXES) {
      expect(report.matched[prefix], `${prefix} 没有命中任何控制器`).not.toHaveLength(0)
    }
    // 显式钉住当前的对应关系：有人把 bootstrap 挪走时，这条会红并指出挪到哪去了。
    expect(report.matched['/api/admin/auth']).toContain('/api/admin/auth')
    expect(report.matched['/api/admin/billing']).toContain('/api/admin/billing')
    expect(report.matched['/api/admin/bootstrap']).toContain('/api/admin/bootstrap')
  })
})

describe('spec 8：套餐功能项与路径前缀', () => {
  it('功能项注册表非空（空表会让下面全绿）', () => {
    expect(FEATURES.length).toBeGreaterThan(0)
    expect(FEATURES.every((f) => f.pathPrefixes !== undefined && f.pathPrefixes.length > 0)).toBe(
      true,
    )
  })

  it('没有任何功能项盖住续费白名单', () => {
    // 装配时 `BillingModule.forRoot` 也会跑一次同样的断言，两处并不重复：
    // 那一次要起应用才发生，这一次在 CI 的单测阶段就发生。
    expect(() => assertFeatureNotShadowingRenewal(FEATURES)).not.toThrow()
  })

  it('哨兵：一条盖住 `/api/admin` 的功能项必须被抓出来', () => {
    expect(() =>
      assertFeatureNotShadowingRenewal([
        { key: 'evil', name: '什么都盖住', writeOnly: true, pathPrefixes: ['/api/admin'] },
      ]),
    ).toThrow()
  })

  it('每条功能项的 pathPrefixes 都指向真实存在的控制器', () => {
    const dangling = FEATURES.flatMap((feature) =>
      (feature.pathPrefixes ?? [])
        .filter((prefix) => !isCoveredByController(prefix))
        .map((prefix) => `功能项 ${feature.key} 的前缀 ${prefix} 没有对应的控制器`),
    )
    expect(
      dangling,
      '功能项的前缀写错 = 闸门静默失效：接口照常通，而平台在套餐里取消勾选后什么也没发生。',
    ).toEqual([])
  })
})
