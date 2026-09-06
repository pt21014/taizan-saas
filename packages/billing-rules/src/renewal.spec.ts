import { describe, expect, it } from 'vitest'

import type { FeatureDef } from './feature'
import {
  ALWAYS_WRITABLE_PREFIXES,
  assertFeatureNotShadowingRenewal,
  findRenewalShadowConflicts,
  isRenewalPath,
} from './renewal'

function def(key: string, pathPrefixes: string[]): FeatureDef {
  return { key, name: key, writeOnly: true, pathPrefixes }
}

describe('ALWAYS_WRITABLE_PREFIXES', () => {
  it('就是蓝图定死的那三条', () => {
    expect([...ALWAYS_WRITABLE_PREFIXES]).toEqual([
      '/api/admin/auth',
      '/api/admin/billing',
      '/api/admin/bootstrap',
    ])
  })

  it('全部带 /api 全局前缀（与真实 @Controller 前缀对齐，spec 8 会逐条比）', () => {
    for (const p of ALWAYS_WRITABLE_PREFIXES) {
      expect(p.startsWith('/api/')).toBe(true)
    }
  })

  it('没有任何一条以斜杠结尾', () => {
    for (const p of ALWAYS_WRITABLE_PREFIXES) {
      expect(p.endsWith('/')).toBe(false)
    }
  })
})

describe('isRenewalPath / 精确前缀命中', () => {
  for (const p of ALWAYS_WRITABLE_PREFIXES) {
    it(`${p} 本身命中`, () => {
      expect(isRenewalPath(p)).toBe(true)
    })
    it(`${p}/xxx 子路径命中`, () => {
      expect(isRenewalPath(`${p}/xxx`)).toBe(true)
    })
  }

  it('切店接口命中（切店是个 POST，锁掉商家就被关在到期的那家店里）', () => {
    expect(isRenewalPath('/api/admin/auth/switch-tenant')).toBe(true)
  })

  it('下单接口命中', () => {
    expect(isRenewalPath('/api/admin/billing/orders')).toBe(true)
  })

  it('带 query 时命中', () => {
    expect(isRenewalPath('/api/admin/billing/orders?page=1')).toBe(true)
  })

  it('结尾斜杠时命中', () => {
    expect(isRenewalPath('/api/admin/billing/')).toBe(true)
  })

  it('重复斜杠时命中', () => {
    expect(isRenewalPath('//api//admin//billing')).toBe(true)
  })
})

describe('isRenewalPath / 边界不放行', () => {
  it('/api/admin/authx 不算（少了这个边界，一个新模块会被静默永久放行）', () => {
    expect(isRenewalPath('/api/admin/authx')).toBe(false)
  })

  it('/api/admin/authx/login 不算', () => {
    expect(isRenewalPath('/api/admin/authx/login')).toBe(false)
  })

  it('/api/admin/billing-report 不算', () => {
    expect(isRenewalPath('/api/admin/billing-report')).toBe(false)
  })

  it('/api/admin/bootstrapper 不算', () => {
    expect(isRenewalPath('/api/admin/bootstrapper')).toBe(false)
  })

  it('上级路径 /api/admin 不算', () => {
    expect(isRenewalPath('/api/admin')).toBe(false)
  })

  it('普通业务路径不算', () => {
    expect(isRenewalPath('/api/admin/goods')).toBe(false)
  })

  it('C 端同名路径不算', () => {
    expect(isRenewalPath('/api/client/billing')).toBe(false)
  })

  it('平台侧同名路径不算', () => {
    expect(isRenewalPath('/api/platform/billing')).toBe(false)
  })

  it('大小写不同不算（路由是大小写敏感的）', () => {
    expect(isRenewalPath('/API/ADMIN/BILLING')).toBe(false)
  })

  it('不带 /api 前缀的路径不算（本包统一用完整路径）', () => {
    expect(isRenewalPath('/admin/billing')).toBe(false)
  })
})

describe('findRenewalShadowConflicts', () => {
  it('正常的功能前缀没有冲突', () => {
    expect(findRenewalShadowConflicts([def('COUPON', ['/api/admin/coupons'])])).toEqual([])
  })

  it('空注册表没有冲突', () => {
    expect(findRenewalShadowConflicts([])).toEqual([])
  })

  it('/api/admin 盖住全部三条白名单', () => {
    const c = findRenewalShadowConflicts([def('WIDE', ['/api/admin'])])
    expect(c).toHaveLength(3)
    expect(c.every((x) => x.kind === 'COVERS')).toBe(true)
  })

  it('/api 盖住全部三条白名单', () => {
    expect(findRenewalShadowConflicts([def('WIDER', ['/api'])])).toHaveLength(3)
  })

  it('与白名单完全相等算 COVERS', () => {
    const c = findRenewalShadowConflicts([def('BILL', ['/api/admin/billing'])])
    expect(c).toEqual([
      {
        featureKey: 'BILL',
        featurePrefix: '/api/admin/billing',
        renewalPrefix: '/api/admin/billing',
        kind: 'COVERS',
      },
    ])
  })

  it('钻进白名单内部算 NESTED', () => {
    const c = findRenewalShadowConflicts([def('INV', ['/api/admin/billing/invoice'])])
    expect(c[0]).toMatchObject({ kind: 'NESTED', renewalPrefix: '/api/admin/billing' })
  })

  it('边界相邻（authx）不算冲突', () => {
    expect(findRenewalShadowConflicts([def('X', ['/api/admin/authx'])])).toEqual([])
  })

  it('前缀未归一化（结尾斜杠）也能查出来', () => {
    expect(findRenewalShadowConflicts([def('B', ['/api/admin/billing/'])])).toHaveLength(1)
  })

  it('同一个 def 的多条前缀分别记账', () => {
    const c = findRenewalShadowConflicts([
      def('M', ['/api/admin/auth', '/api/admin/billing/x', '/api/admin/goods']),
    ])
    expect(c).toHaveLength(2)
  })

  it('多个 def 各自的冲突都会被列出来', () => {
    const c = findRenewalShadowConflicts([
      def('A', ['/api/admin/auth']),
      def('B', ['/api/admin/bootstrap/init']),
    ])
    expect(c.map((x) => x.featureKey)).toEqual(['A', 'B'])
  })
})

describe('assertFeatureNotShadowingRenewal', () => {
  it('没有冲突时不抛', () => {
    expect(() =>
      assertFeatureNotShadowingRenewal([def('COUPON', ['/api/admin/coupons'])]),
    ).not.toThrow()
  })

  it('空注册表不抛', () => {
    expect(() => assertFeatureNotShadowingRenewal([])).not.toThrow()
  })

  it('COVERS 型遮蔽抛错', () => {
    expect(() => assertFeatureNotShadowingRenewal([def('WIDE', ['/api/admin'])])).toThrow(Error)
  })

  it('NESTED 型遮蔽抛错', () => {
    expect(() =>
      assertFeatureNotShadowingRenewal([def('INV', ['/api/admin/billing/invoice'])]),
    ).toThrow(Error)
  })

  it('错误信息点名是哪个 feature', () => {
    expect(() => assertFeatureNotShadowingRenewal([def('WIDE', ['/api/admin'])])).toThrow(/WIDE/)
  })

  it('错误信息说清后果：商家到期后将无法续费', () => {
    expect(() => assertFeatureNotShadowingRenewal([def('WIDE', ['/api/admin'])])).toThrow(
      /到期后将无法续费/,
    )
  })

  it('错误信息逐条列出冲突（三条白名单被盖 → 三行）', () => {
    try {
      assertFeatureNotShadowingRenewal([def('WIDE', ['/api/admin'])])
      expect.unreachable('应当抛错')
    } catch (e) {
      expect(
        String((e as Error).message)
          .split('\n')
          .filter((l) => l.startsWith('  - ')),
      ).toHaveLength(3)
    }
  })
})
