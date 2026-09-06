/**
 * T1-2 验收用例⑩ / 蓝图 §8 spec 6 的**样板**：`permission-registry.spec.ts`。
 *
 * `apps/api/test/arch/permission-registry.spec.ts` 直接 import 这里的
 * `scanRequirePermissionUsages` + `crossCheckPermissions` 去扫真实源码，
 * 不要在下游再抄一份实现。本文件用 fixtures 证明扫描器本身是对的。
 */

import { describe, expect, it } from 'vitest'
import { fixtureMenus, fixturePermissions } from '../testing/fixtures'
import {
  crossCheckPermissions,
  scanRequirePermissionUsages,
  SENTINEL_EXPECTATION,
  SENTINEL_SOURCE,
  type SourceFile,
} from './require-permission.scan'

function files(source: string): SourceFile[] {
  return [{ path: 'fixture.ts', source }]
}

describe('哨兵：正则一旦失效，这里先炸', () => {
  it('哨兵源码被扫出确定的使用点数与 code 集合', () => {
    const usages = scanRequirePermissionUsages(files(SENTINEL_SOURCE))
    expect(usages).toHaveLength(SENTINEL_EXPECTATION.usages)
    const codes = [...new Set(usages.flatMap((u) => u.codes))].sort()
    expect(codes).toEqual([...SENTINEL_EXPECTATION.codes])
  })

  it('「一条都没扫到」不等于「没有问题」——所以哨兵断言的是具体数字而不是 >= 0', () => {
    expect(SENTINEL_EXPECTATION.usages).toBeGreaterThan(0)
  })
})

describe('scanRequirePermissionUsages', () => {
  it('单点表达式', () => {
    const usages = scanRequirePermissionUsages(files(`@RequirePermission('goods:list')`))
    expect(usages[0]?.codes).toEqual(['goods:list'])
    expect(usages[0]?.line).toBe(1)
  })

  it('或表达式里的两个 code 都收进来（一个字面量拆成两个 code）', () => {
    const usages = scanRequirePermissionUsages(files(`@RequirePermission('a:b|c:d')`))
    expect(usages[0]?.codes).toEqual(['a:b', 'c:d'])
    expect(usages[0]?.raw).toContain('a:b|c:d')
  })

  it('跨行的数组写法也能扫到', () => {
    const usages = scanRequirePermissionUsages(
      files(`  @RequirePermission([\n    'goods:write',\n    'shop:read',\n  ])`),
    )
    expect(usages).toHaveLength(1)
    expect(usages[0]?.codes).toEqual(['goods:write', 'shop:read'])
  })

  it('双引号与反引号一视同仁', () => {
    expect(scanRequirePermissionUsages(files(`@RequirePermission("a:b")`))[0]?.codes).toEqual([
      'a:b',
    ])
  })

  it('没有装饰器的源码扫出空数组', () => {
    expect(scanRequirePermissionUsages(files('export const x = 1'))).toEqual([])
  })

  it('多文件时带上各自的路径与行号', () => {
    const usages = scanRequirePermissionUsages([
      { path: 'a.ts', source: `\n@RequirePermission('a:b')` },
      { path: 'b.ts', source: `@RequirePermission('c:d')` },
    ])
    expect(usages.map((u) => `${u.file}:${u.line}`)).toEqual(['a.ts:2', 'b.ts:1'])
  })
})

describe('crossCheckPermissions：双向对账', () => {
  const PERMISSIONS = fixturePermissions()

  it('全部对得上时零违规', () => {
    const usages = scanRequirePermissionUsages(
      files(`
        @RequirePermission('goods:list')
        @RequirePermission('goods:write')
        @RequirePermission('order:refund')
      `),
    )
    const report = crossCheckPermissions(usages, PERMISSIONS, {
      menus: fixtureMenus(),
      // goods:export 是 BUTTON，默认不参与死权限检查。
    })
    expect(report.violations).toEqual([])
  })

  it('方向一：源码里引用了未注册的 code', () => {
    const usages = scanRequirePermissionUsages(files(`@RequirePermission('ghost:code')`))
    const report = crossCheckPermissions(usages, PERMISSIONS, { menus: fixtureMenus() })
    const violation = report.violations.find((v) => v.rule === 'unregistered-code')
    expect(violation?.code).toBe('ghost:code')
    expect(violation?.at).toBe('fixture.ts:1')
  })

  it('方向二：注册表里的 API 权限点没有任何路由或菜单引用 = 死权限', () => {
    const report = crossCheckPermissions([], PERMISSIONS, {})
    const dead = report.violations.filter((v) => v.rule === 'dead-permission').map((v) => v.code)
    // 四个 API 类都没人引用；BUTTON 类的 goods:export 不参与检查。
    expect(dead).toEqual(['goods:list', 'goods:write', 'order:list', 'order:refund', 'coupon:list'])
    expect(dead).not.toContain('goods:export')
  })

  it('菜单的 permission 也算「被引用」', () => {
    const report = crossCheckPermissions([], PERMISSIONS, { menus: fixtureMenus() })
    const dead = report.violations.filter((v) => v.rule === 'dead-permission').map((v) => v.code)
    // 菜单引用了 goods:list / goods:write / goods:export / order:list / coupon:list，
    // 只剩 order:refund 没人用。
    expect(dead).toEqual(['order:refund'])
  })

  it('allowUnused 白名单放行（每条都该在调用处写理由）', () => {
    const report = crossCheckPermissions([], PERMISSIONS, {
      menus: fixtureMenus(),
      allowUnused: ['order:refund'],
    })
    expect(report.violations).toEqual([])
  })

  it('checkTypes 可以把 BUTTON 也纳入检查', () => {
    const report = crossCheckPermissions([], PERMISSIONS, { checkTypes: ['API', 'BUTTON'] })
    expect(report.violations.map((v) => v.code)).toContain('goods:export')
  })

  it('传 code 数组而不是权限点表时也能工作（类型信息缺失，全部参与检查）', () => {
    const report = crossCheckPermissions([], ['a:b'], {})
    expect(report.violations.map((v) => v.code)).toEqual(['a:b'])
  })

  it('报告里带上双向的 code 全集，方便失败时人眼比对', () => {
    const usages = scanRequirePermissionUsages(files(`@RequirePermission('goods:list')`))
    const report = crossCheckPermissions(usages, PERMISSIONS, {})
    expect(report.usedCodes).toEqual(['goods:list'])
    expect(report.registeredCodes).toHaveLength(6)
  })
})
