/**
 * 蓝图 §8 第 8 条（`billing-routes.spec.ts`）的**样板**。
 *
 * ## 给 `apps/api` 的用法
 *
 * 本文件用 fixtures 证明判定函数本身是对的。真实项目里把 fixtures 换成扫源码的结果：
 *
 * ```ts
 * import { assertRenewalPrefixes } from '@taizan/nest-billing'
 * import { BILLING_FEATURES } from '../src/bootstrap/features'
 * import { assertFeatureNotShadowingRenewal } from '@taizan/billing-rules'
 *
 * it('续费白名单每条都有真实控制器兑现', () => {
 *   const prefixes = scanControllerPrefixes('src')     // 项目自己的扫描器
 *   expect(() => assertRenewalPrefixes(prefixes)).not.toThrow()
 * })
 *
 * it('功能开关没有盖住续费白名单', () => {
 *   expect(() => assertFeatureNotShadowingRenewal(BILLING_FEATURES)).not.toThrow()
 * })
 * ```
 *
 * 两条断言守的是同一个死循环的两侧：白名单指向空气 / 功能开关盖住白名单，
 * 结果都是「到期 → 只读 → 续不了费 → 永远到期」。
 */

import { ALWAYS_WRITABLE_PREFIXES, assertFeatureNotShadowingRenewal } from '@taizan/billing-rules'
import { describe, expect, it } from 'vitest'
import { assertRenewalPrefixes, verifyRenewalPrefixes } from './billing-routes'

/** 一份「接线正确」的控制器前缀清单，形状照着 apps/api 将来会有的样子写。 */
const GOOD_PREFIXES = [
  'api/admin/auth',
  'api/admin/billing/order',
  'api/admin/billing/plan',
  'api/admin/bootstrap',
  'api/admin/goods',
  'api/client/goods',
  'api/platform/tenant',
]

describe('verifyRenewalPrefixes：白名单 → 控制器', () => {
  it('三条白名单都有控制器兑现时通过', () => {
    const report = verifyRenewalPrefixes(GOOD_PREFIXES)
    expect(report.ok).toBe(true)
    expect(report.violations).toEqual([])
  })

  it('子路径算兑现——白名单是前缀，不要求有同名控制器', () => {
    expect(verifyRenewalPrefixes(GOOD_PREFIXES).matched['/api/admin/billing']).toEqual([
      '/api/admin/billing/order',
      '/api/admin/billing/plan',
    ])
  })

  it('少了续费控制器就报出来，理由里写清那个死循环', () => {
    const report = verifyRenewalPrefixes(GOOD_PREFIXES.filter((p) => !p.includes('billing')))
    expect(report.ok).toBe(false)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]?.prefix).toBe('/api/admin/billing')
    expect(report.violations[0]?.reason).toContain('永远到期')
  })

  it('名字更短的前缀不算兑现（/api/admin/bill ≠ /api/admin/billing）', () => {
    const report = verifyRenewalPrefixes([
      'api/admin/auth',
      'api/admin/bill',
      'api/admin/bootstrap',
    ])
    expect(report.ok).toBe(false)
    expect(report.violations[0]?.prefix).toBe('/api/admin/billing')
  })

  it('带前导斜杠、尾随斜杠、重复斜杠都归一化', () => {
    expect(
      verifyRenewalPrefixes(['/api/admin/auth/', 'api//admin//billing', '/api/admin/bootstrap']).ok,
    ).toBe(true)
  })

  it('空串与裸斜杠被忽略——否则 "/" 会假装兑现了所有白名单', () => {
    const report = verifyRenewalPrefixes(['', ' ', '/'])
    expect(report.ok).toBe(false)
    expect(report.violations).toHaveLength(ALWAYS_WRITABLE_PREFIXES.length)
  })

  it('assertRenewalPrefixes 把三条违规拼成一条中文错误', () => {
    expect(() => assertRenewalPrefixes([])).toThrow(/续费白名单与控制器对不上/)
    expect(() => assertRenewalPrefixes(GOOD_PREFIXES)).not.toThrow()
  })
})

describe('功能开关 → 白名单（另一侧，判定在 @taizan/billing-rules）', () => {
  it('一份正常的功能注册表不炸', () => {
    expect(() =>
      assertFeatureNotShadowingRenewal([
        {
          key: 'marketing',
          name: '营销中心',
          writeOnly: true,
          pathPrefixes: ['/api/admin/marketing'],
        },
        { key: 'crm', name: '会员管理', writeOnly: true, pathPrefixes: ['/api/admin/member'] },
      ]),
    ).not.toThrow()
  })

  it('盖住 /api/admin 的功能项会炸', () => {
    expect(() =>
      assertFeatureNotShadowingRenewal([
        { key: 'all', name: '全部', writeOnly: true, pathPrefixes: ['/api/admin'] },
      ]),
    ).toThrow(/遮蔽了续费白名单/)
  })
})
