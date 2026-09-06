import { describe, expect, it } from 'vitest'

import { ErrorCode } from '@taizan/contracts'

import {
  FEATURE_NOT_INCLUDED_CODE,
  WRITE_METHODS,
  checkFeatureAccess,
  featureToErrorCode,
  hasFeature,
  matchFeatureByPath,
  normalizePathPrefix,
  pathHasPrefix,
  type FeatureDef,
} from './feature'

const COUPON: FeatureDef = {
  key: 'COUPON',
  name: '优惠券',
  writeOnly: true,
  pathPrefixes: ['/api/admin/coupons'],
}

const SALARY: FeatureDef = {
  key: 'SALARY',
  name: '薪资',
  writeOnly: false,
  pathPrefixes: ['/api/admin/salary'],
}

const LIVE: FeatureDef = {
  key: 'LIVE',
  name: '直播',
  writeOnly: true,
  pathPrefixes: ['/api/admin/live', '/api/admin/live-console'],
}

const DEFS = [COUPON, SALARY, LIVE]

describe('hasFeature / 三态', () => {
  it('features=null → 全部可用', () => {
    expect(hasFeature(null, 'COUPON')).toBe(true)
  })

  it('features=null 时任何 key 都可用（存量套餐上线当天谁的能力都不变）', () => {
    expect(hasFeature(null, '随便一个没注册过的 key')).toBe(true)
  })

  it('features=[] → 一个都不给', () => {
    expect(hasFeature([], 'COUPON')).toBe(false)
  })

  it('features=[] 与 features=null 结论相反', () => {
    expect(hasFeature([], 'COUPON')).toBe(false)
    expect(hasFeature(null, 'COUPON')).toBe(true)
  })

  it('白名单里有 → 可用', () => {
    expect(hasFeature(['COUPON', 'LIVE'], 'COUPON')).toBe(true)
  })

  it('白名单里没有 → 不可用', () => {
    expect(hasFeature(['LIVE'], 'COUPON')).toBe(false)
  })

  it('大小写敏感（key 是常量，不做模糊匹配）', () => {
    expect(hasFeature(['COUPON'], 'coupon')).toBe(false)
  })
})

describe('normalizePathPrefix', () => {
  it('补上前导斜杠', () => {
    expect(normalizePathPrefix('api/admin/coupons')).toBe('/api/admin/coupons')
  })

  it('削掉 query', () => {
    expect(normalizePathPrefix('/api/admin/coupons?page=1')).toBe('/api/admin/coupons')
  })

  it('削掉 hash', () => {
    expect(normalizePathPrefix('/api/admin/coupons#top')).toBe('/api/admin/coupons')
  })

  it('去掉结尾斜杠', () => {
    expect(normalizePathPrefix('/api/admin/coupons/')).toBe('/api/admin/coupons')
  })

  it('去掉多个结尾斜杠', () => {
    expect(normalizePathPrefix('/api/admin/coupons///')).toBe('/api/admin/coupons')
  })

  it('合并重复斜杠', () => {
    expect(normalizePathPrefix('//api//admin///coupons')).toBe('/api/admin/coupons')
  })

  it('已经规范的前缀原样返回', () => {
    expect(normalizePathPrefix('/api/admin/coupons')).toBe('/api/admin/coupons')
  })

  it('空串抛 TypeError（会匹配全站，是最危险的一种写错）', () => {
    expect(() => normalizePathPrefix('')).toThrow(TypeError)
  })

  it('只有一个斜杠时抛', () => {
    expect(() => normalizePathPrefix('/')).toThrow(/匹配全站/)
  })

  it('只有多个斜杠时抛', () => {
    expect(() => normalizePathPrefix('///')).toThrow(TypeError)
  })

  it('非字符串抛', () => {
    expect(() => normalizePathPrefix(null as unknown as string)).toThrow(TypeError)
  })
})

describe('pathHasPrefix / 段边界', () => {
  it('完全相等命中', () => {
    expect(pathHasPrefix('/api/admin/auth', '/api/admin/auth')).toBe(true)
  })

  it('子路径命中', () => {
    expect(pathHasPrefix('/api/admin/auth/switch-tenant', '/api/admin/auth')).toBe(true)
  })

  it('多级子路径命中', () => {
    expect(pathHasPrefix('/api/admin/auth/a/b/c', '/api/admin/auth')).toBe(true)
  })

  it('同前缀不同段（authx）不命中', () => {
    expect(pathHasPrefix('/api/admin/authx', '/api/admin/auth')).toBe(false)
  })

  it('同前缀不同段的子路径（authx/login）也不命中', () => {
    expect(pathHasPrefix('/api/admin/authx/login', '/api/admin/auth')).toBe(false)
  })

  it('上级路径不命中下级前缀', () => {
    expect(pathHasPrefix('/api/admin', '/api/admin/auth')).toBe(false)
  })

  it('带 query 的路径命中', () => {
    expect(pathHasPrefix('/api/admin/auth/login?from=x', '/api/admin/auth')).toBe(true)
  })

  it('结尾斜杠命中', () => {
    expect(pathHasPrefix('/api/admin/auth/', '/api/admin/auth')).toBe(true)
  })

  it('大小写敏感', () => {
    expect(pathHasPrefix('/API/Admin/Auth', '/api/admin/auth')).toBe(false)
  })
})

describe('matchFeatureByPath / 写拦读不拦', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`${method} 命中前缀时需要该 feature`, () => {
      expect(matchFeatureByPath(DEFS, '/api/admin/coupons', method)?.key).toBe('COUPON')
    })
  }

  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    it(`${method} 命中前缀但 writeOnly=true 时不拦`, () => {
      expect(matchFeatureByPath(DEFS, '/api/admin/coupons', method)).toBeNull()
    })
  }

  it('WRITE_METHODS 就是那四个方法', () => {
    expect([...WRITE_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT'])
  })

  it('方法小写也识别', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/coupons', 'post')?.key).toBe('COUPON')
  })

  it('方法混合大小写也识别', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/coupons', 'DeLeTe')?.key).toBe('COUPON')
  })

  it('writeOnly=false 时 GET 也需要该 feature', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/salary/list', 'GET')?.key).toBe('SALARY')
  })

  it('writeOnly=false 时 POST 当然也需要', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/salary', 'POST')?.key).toBe('SALARY')
  })

  it('子路径的写操作命中', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/coupons/123/publish', 'POST')?.key).toBe('COUPON')
  })

  it('前缀边界：/api/admin/couponsx 不命中', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/couponsx', 'POST')).toBeNull()
  })

  it('不在任何前缀下 → null（这个接口不受功能开关管）', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/goods', 'POST')).toBeNull()
  })

  it('一个 def 的多个前缀任一命中即可（第一个）', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/live/rooms', 'POST')?.key).toBe('LIVE')
  })

  it('一个 def 的多个前缀任一命中即可（第二个）', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/live-console', 'POST')?.key).toBe('LIVE')
  })

  it('注册表为空时永远返回 null', () => {
    expect(matchFeatureByPath([], '/api/admin/coupons', 'POST')).toBeNull()
  })

  it('多个 def 命中同一路径时返回注册表里靠前的那个', () => {
    const dup: FeatureDef = { ...COUPON, key: 'COUPON_V2' }
    expect(matchFeatureByPath([dup, COUPON], '/api/admin/coupons', 'POST')?.key).toBe('COUPON_V2')
  })

  it('带 query 的请求路径照样命中', () => {
    expect(matchFeatureByPath(DEFS, '/api/admin/coupons?draft=1', 'POST')?.key).toBe('COUPON')
  })
})

describe('checkFeatureAccess', () => {
  it('features=null 时放行，但仍告知需要哪个 feature', () => {
    const r = checkFeatureAccess(DEFS, null, '/api/admin/coupons', 'POST')
    expect(r.allowed).toBe(true)
    expect(r.required?.key).toBe('COUPON')
  })

  it('features=[] 时拦住', () => {
    expect(checkFeatureAccess(DEFS, [], '/api/admin/coupons', 'POST').allowed).toBe(false)
  })

  it('features 含该 key 时放行', () => {
    expect(checkFeatureAccess(DEFS, ['COUPON'], '/api/admin/coupons', 'POST').allowed).toBe(true)
  })

  it('features 不含该 key 时拦住', () => {
    expect(checkFeatureAccess(DEFS, ['LIVE'], '/api/admin/coupons', 'POST').allowed).toBe(false)
  })

  it('路径不受功能开关管时放行且 required 为 null', () => {
    expect(checkFeatureAccess(DEFS, [], '/api/admin/goods', 'POST')).toEqual({
      allowed: true,
      required: null,
    })
  })

  it('套餐没勾优惠券时，读接口照常能查（写拦读不拦）', () => {
    expect(checkFeatureAccess(DEFS, [], '/api/admin/coupons', 'GET').allowed).toBe(true)
  })

  it('writeOnly=false 的功能连读都拦', () => {
    expect(checkFeatureAccess(DEFS, [], '/api/admin/salary', 'GET').allowed).toBe(false)
  })
})

describe('featureToErrorCode', () => {
  it('被拦 → 1540302', () => {
    expect(featureToErrorCode({ allowed: false })).toBe(1540302)
  })

  it('放行 → null', () => {
    expect(featureToErrorCode({ allowed: true })).toBeNull()
  })

  it('FEATURE_NOT_INCLUDED_CODE 取自 @taizan/contracts', () => {
    expect(FEATURE_NOT_INCLUDED_CODE).toBe(ErrorCode.FEATURE_NOT_INCLUDED.code)
  })

  it('功能码与配额码不同（一个要买插件、一个要加量）', () => {
    expect(FEATURE_NOT_INCLUDED_CODE).not.toBe(ErrorCode.QUOTA_EXCEEDED.code)
  })

  it('功能码与套餐到期码不同', () => {
    expect(FEATURE_NOT_INCLUDED_CODE).not.toBe(ErrorCode.PLAN_READONLY.code)
  })
})
