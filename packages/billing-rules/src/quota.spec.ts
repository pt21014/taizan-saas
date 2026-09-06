import { describe, expect, it } from 'vitest'

import { ErrorCode } from '@taizan/contracts'

import { QUOTA_EXCEEDED_CODE, checkQuota, quotaToErrorCode, resolveQuota } from './quota'

describe('checkQuota / 三态：null 不限', () => {
  it('limit=null 时放行', () => {
    expect(checkQuota(null, 0)).toMatchObject({ ok: true, limit: null, remaining: null })
  })

  it('limit=null 时已用量再大也放行', () => {
    expect(checkQuota(null, 999_999, 1000).ok).toBe(true)
  })

  it('limit=null 时不返回 reason', () => {
    expect(checkQuota(null, 5).reason).toBeUndefined()
  })

  it('limit=null 时 remaining 为 null 而不是 Infinity', () => {
    expect(checkQuota(null, 5).remaining).toBeNull()
  })
})

describe('checkQuota / 三态：0 一个都不给', () => {
  it('limit=0 时创建一个就被拦', () => {
    expect(checkQuota(0, 0)).toMatchObject({ ok: false, reason: 'EXCEEDED', limit: 0 })
  })

  it('limit=0 与 limit=null 结论相反（三态合并成两态就是在这里出事）', () => {
    expect(checkQuota(0, 0).ok).toBe(false)
    expect(checkQuota(null, 0).ok).toBe(true)
  })

  it('limit=0 且 delta=0 时只是「看一眼」，放行', () => {
    expect(checkQuota(0, 0, 0).ok).toBe(true)
  })

  it('limit=0 时 remaining 为 0', () => {
    expect(checkQuota(0, 0).remaining).toBe(0)
  })
})

describe('checkQuota / 三态：正整数上限', () => {
  it('用满前一个：放行且 remaining=0', () => {
    expect(checkQuota(3, 2)).toMatchObject({ ok: true, remaining: 0 })
  })

  it('刚好用满：再来一个被拦', () => {
    expect(checkQuota(3, 3)).toMatchObject({ ok: false, reason: 'EXCEEDED' })
  })

  it('还剩余量时 remaining 正确', () => {
    expect(checkQuota(10, 3).remaining).toBe(6)
  })

  it('delta 默认为 1', () => {
    expect(checkQuota(1, 0)).toEqual(checkQuota(1, 0, 1))
  })

  it('一次批量消耗超限被拦', () => {
    expect(checkQuota(10, 8, 5).ok).toBe(false)
  })

  it('一次批量消耗刚好用满放行', () => {
    expect(checkQuota(10, 8, 2)).toMatchObject({ ok: true, remaining: 0 })
  })

  it('delta=0 且未超时放行', () => {
    expect(checkQuota(10, 3, 0)).toMatchObject({ ok: true, remaining: 7 })
  })

  it('delta=0 且已用满时仍放行（没有新增消耗）', () => {
    expect(checkQuota(10, 10, 0).ok).toBe(true)
  })

  it('已用量超过上限（历史脏数据/套餐降级）时 remaining 不返回负数', () => {
    expect(checkQuota(3, 10).remaining).toBe(0)
  })

  it('已用量超过上限时被拦', () => {
    expect(checkQuota(3, 10).ok).toBe(false)
  })

  it('limit/used/delta 原样回传，方便直接拼提示文案', () => {
    expect(checkQuota(5, 2, 3)).toMatchObject({ limit: 5, used: 2, delta: 3 })
  })

  it('放行时不带 reason', () => {
    expect(checkQuota(5, 1).reason).toBeUndefined()
  })
})

describe('checkQuota / 入参校验（脏数据当场炸，不宽容成「不限量」）', () => {
  it('limit 为负数时抛 RangeError', () => {
    expect(() => checkQuota(-1, 0)).toThrow(RangeError)
  })

  it('limit 为小数时抛', () => {
    expect(() => checkQuota(1.5, 0)).toThrow(/limit/)
  })

  it('limit 为 NaN 时抛', () => {
    expect(() => checkQuota(Number.NaN, 0)).toThrow(RangeError)
  })

  it('used 为负数时抛', () => {
    expect(() => checkQuota(3, -1)).toThrow(/used/)
  })

  it('used 为小数时抛', () => {
    expect(() => checkQuota(3, 0.5)).toThrow(RangeError)
  })

  it('delta 为负数时抛（释放配额不走这个函数）', () => {
    expect(() => checkQuota(3, 1, -1)).toThrow(/delta/)
  })

  it('delta 为小数时抛', () => {
    expect(() => checkQuota(3, 1, 1.2)).toThrow(RangeError)
  })

  it('报错前缀带包名，便于线上定位', () => {
    expect(() => checkQuota(-1, 0)).toThrow(/@taizan\/billing-rules/)
  })
})

describe('resolveQuota / 租户级覆盖优先', () => {
  const plan = { STAFF: 3, STORE: 0, MEMBER: null } as Record<string, number | null>

  it('不传 override 时用套餐值', () => {
    expect(resolveQuota(plan, 'STAFF')).toBe(3)
  })

  it('override=undefined 显式传入时也不覆盖', () => {
    expect(resolveQuota(plan, 'STAFF', undefined)).toBe(3)
  })

  it('override=null 表示「显式不限量」，不退回套餐值', () => {
    expect(resolveQuota(plan, 'STAFF', null)).toBeNull()
  })

  it('override=0 表示单独把这家店这个维度关掉', () => {
    expect(resolveQuota(plan, 'STAFF', 0)).toBe(0)
  })

  it('override 为正数时覆盖套餐值', () => {
    expect(resolveQuota(plan, 'STAFF', 99)).toBe(99)
  })

  it('套餐值为 null（显式不限）时返回 null', () => {
    expect(resolveQuota(plan, 'MEMBER')).toBeNull()
  })

  it('套餐值为 0（一个都不给）时返回 0，不被当成假值吞掉', () => {
    expect(resolveQuota(plan, 'STORE')).toBe(0)
  })

  it('套餐里 key 缺省时按不限量处理（加新维度不该锁死存量商家）', () => {
    expect(resolveQuota(plan, 'STORAGE_MB')).toBeNull()
  })

  it('key 存在但值是 undefined 时也按不限量处理', () => {
    expect(
      resolveQuota({ STAFF: undefined } as unknown as Record<string, number | null>, 'STAFF'),
    ).toBeNull()
  })

  it('原型链上的同名属性不算（避免 constructor / toString 之类被误当配额）', () => {
    expect(resolveQuota({}, 'constructor')).toBeNull()
  })

  it('套餐值是负数（Json 存坏了）时抛 RangeError 并指出是哪个维度', () => {
    expect(() => resolveQuota({ STAFF: -5 }, 'STAFF')).toThrow(/quotas\.STAFF/)
  })

  it('override 是负数时同样抛', () => {
    expect(() => resolveQuota(plan, 'STAFF', -1)).toThrow(RangeError)
  })

  it('resolveQuota 的结果可以直接喂给 checkQuota', () => {
    expect(checkQuota(resolveQuota(plan, 'STORE'), 0).ok).toBe(false)
    expect(checkQuota(resolveQuota(plan, 'MEMBER'), 10_000).ok).toBe(true)
  })
})

describe('quotaToErrorCode', () => {
  it('超限 → 1540301', () => {
    expect(quotaToErrorCode(checkQuota(0, 0))).toBe(1540301)
  })

  it('放行 → null', () => {
    expect(quotaToErrorCode(checkQuota(null, 0))).toBeNull()
  })

  it('QUOTA_EXCEEDED_CODE 取自 @taizan/contracts', () => {
    expect(QUOTA_EXCEEDED_CODE).toBe(ErrorCode.QUOTA_EXCEEDED.code)
  })

  it('配额码与套餐到期码不同（三道闸门并列不合并）', () => {
    expect(QUOTA_EXCEEDED_CODE).not.toBe(ErrorCode.PLAN_READONLY.code)
  })

  it('配额码与功能未包含码不同', () => {
    expect(QUOTA_EXCEEDED_CODE).not.toBe(ErrorCode.FEATURE_NOT_INCLUDED.code)
  })
})
