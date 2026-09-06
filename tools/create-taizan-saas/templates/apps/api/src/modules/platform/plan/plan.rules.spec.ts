import { describe, expect, it } from 'vitest'

import {
  validateFeatures,
  validatePlanCoreInput,
  validatePlanCorePatch,
  validateQuotas,
} from './plan.rules'

describe('validateQuotas / 三态', () => {
  it('undefined（这次不改）合法', () => {
    expect(validateQuotas(undefined)).toEqual([])
  })

  it('null 值（不限）合法', () => {
    expect(validateQuotas({ STAFF: null })).toEqual([])
  })

  it('0（禁用）合法，且不会被当成「没填」', () => {
    expect(validateQuotas({ TRAFFIC_MB: 0 })).toEqual([])
  })

  it('正整数（上限）合法', () => {
    expect(validateQuotas({ STAFF: 3 })).toEqual([])
  })

  it('负数非法', () => {
    expect(validateQuotas({ STAFF: -1 })).toHaveLength(1)
  })

  it('小数非法', () => {
    expect(validateQuotas({ STAFF: 1.5 })).toHaveLength(1)
  })

  it('未知维度非法', () => {
    expect(validateQuotas({ NOT_A_KIND: 1 })).toHaveLength(1)
  })

  it('非对象非法', () => {
    expect(validateQuotas('nope')).toHaveLength(1)
    expect(validateQuotas([1, 2])).toHaveLength(1)
  })

  it('null 本身（整个 quotas 传 null）非法——quotas 列不可空，三态只作用在 key 上', () => {
    expect(validateQuotas(null)).toHaveLength(1)
  })
})

describe('validateFeatures / 三态', () => {
  it('undefined（不改）合法', () => {
    expect(validateFeatures(undefined)).toEqual([])
  })

  it('null（全部可用）合法', () => {
    expect(validateFeatures(null)).toEqual([])
  })

  it('空数组（一个都不给）合法，且与 null 是两回事', () => {
    expect(validateFeatures([])).toEqual([])
  })

  it('非空字符串数组合法', () => {
    expect(validateFeatures(['member', 'order'])).toEqual([])
  })

  it('数组里混了非字符串非法', () => {
    expect(validateFeatures(['member', 1])).toHaveLength(1)
  })

  it('非数组非法', () => {
    expect(validateFeatures('member')).toHaveLength(1)
  })
})

describe('validatePlanCoreInput（新建，全量必填）', () => {
  const valid = {
    code: 'gold',
    name: '黄金版',
    firstPriceCents: 9900,
    renewPriceCents: 7900,
    periodMonths: 12,
    appKeys: ['admin'],
    trafficMb: 0,
  }

  it('合法输入零违规', () => {
    expect(validatePlanCoreInput(valid)).toEqual([])
  })

  it('code 为空 / 特殊字符非法；大写会被静默归一化成小写（与 slug 同一口径），不算违规', () => {
    expect(validatePlanCoreInput({ ...valid, code: '' })).toHaveLength(1)
    expect(validatePlanCoreInput({ ...valid, code: 'Gold' })).toEqual([])
    expect(validatePlanCoreInput({ ...valid, code: 'gold_v2' })).toHaveLength(1)
  })

  it('appKeys 空数组非法', () => {
    expect(validatePlanCoreInput({ ...valid, appKeys: [] })).toHaveLength(1)
  })

  it('periodMonths 非正整数非法', () => {
    expect(validatePlanCoreInput({ ...valid, periodMonths: 0 })).toHaveLength(1)
    expect(validatePlanCoreInput({ ...valid, periodMonths: 1.5 })).toHaveLength(1)
  })

  it('trafficMb 缺省合法（可选字段）', () => {
    const { trafficMb: _drop, ...withoutTraffic } = valid
    expect(validatePlanCoreInput(withoutTraffic)).toEqual([])
  })
})

describe('validatePlanCorePatch（只校验传了的字段）', () => {
  it('空 patch 零违规', () => {
    expect(validatePlanCorePatch({})).toEqual([])
  })

  it('只传一个坏字段只报那一个', () => {
    const violations = validatePlanCorePatch({ periodMonths: -1 })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.field).toBe('periodMonths')
  })
})
