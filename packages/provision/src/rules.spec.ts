import { describe, expect, it } from 'vitest'

import { RESERVED_SLUGS } from './reserved-slugs'
import {
  DEFAULT_TRIAL_DAYS,
  assertOwnerPasswordPolicy,
  decideInitialStatus,
  normalizePhone,
  resolveTrialDays,
  validateSlug,
  validateTenantName,
} from './rules'
import { isProvisionError } from './types'

describe('validateSlug', () => {
  it('归一化：trim + 转小写，返回的才是能落库的值', () => {
    expect(validateSlug('  MyShop  ')).toEqual({ ok: true, value: 'myshop' })
  })

  it.each(['ab', 'a'.repeat(33), '-abc', 'abc-', 'my_shop', 'my shop', '我的店', ''])(
    '形状不合法：%s',
    (raw) => {
      const result = validateSlug(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('SLUG_INVALID')
    },
  )

  it.each(['abc', 'a-b', 'a'.repeat(32), 'shop2024', 'my--shop'])('形状合法：%s', (raw) => {
    expect(validateSlug(raw).ok).toBe(true)
  })

  it.each(['admin', 'api', 'platform', 'www', 'static', 'official', 'KEFU'])(
    '保留字被拒：%s',
    (raw) => {
      const result = validateSlug(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('SLUG_RESERVED')
    },
  )

  it('保留字清单里每一条自己都得是合法形状（否则那条永远走不到保留字判定）', () => {
    for (const slug of RESERVED_SLUGS) {
      expect(slug, `保留字 ${slug} 形状不合法`).toMatch(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/)
    }
  })
})

describe('normalizePhone', () => {
  it.each([
    ['138 0000 0000', '13800000000'],
    ['138-0000-0000', '13800000000'],
    ['+8613800000000', '13800000000'],
    ['008613800000000', '13800000000'],
    ['(138)00000000', '13800000000'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected)
  })

  it('不做校验：明显填错的号原样归一化后返回，判定交给 PHONE_PATTERN', () => {
    expect(normalizePhone('abc')).toBe('')
    expect(normalizePhone('123')).toBe('123')
  })
})

describe('validateTenantName', () => {
  it('2–30 个字', () => {
    expect(validateTenantName('小店').ok).toBe(true)
    expect(validateTenantName(' 小 ').ok).toBe(false)
    expect(validateTenantName('店'.repeat(31)).ok).toBe(false)
  })
})

describe('assertOwnerPasswordPolicy', () => {
  it.each(['abcd1234', 'a1234567', 'passw0rd', 'abcdefg!'])('通过：%s', (password) => {
    expect(() => {
      assertOwnerPasswordPolicy(password)
    }).not.toThrow()
  })

  it.each(['', 'abc123', 'a'.repeat(65), '11111111', 'aaaaaaaa', '12345678', 'abcdefgh'])(
    '拒绝：%s',
    (password) => {
      try {
        assertOwnerPasswordPolicy(password)
        throw new Error('should have thrown')
      } catch (error) {
        expect(isProvisionError(error)).toBe(true)
        if (isProvisionError(error)) expect(error.reason).toBe('OWNER_PASSWORD_WEAK')
      }
    },
  )
})

describe('decideInitialStatus', () => {
  it('显式给了 trialDays 就一定是 TRIAL，哪怕同时挂了套餐', () => {
    expect(decideInitialStatus({ trialDays: 14 })).toBe('TRIAL')
    expect(decideInitialStatus({ trialDays: 0 })).toBe('TRIAL')
    expect(decideInitialStatus({ trialDays: 7, planId: 'plan-1' })).toBe('TRIAL')
  })

  it('只给套餐 = 按套餐付费开通', () => {
    expect(decideInitialStatus({ planId: 'plan-1' })).toBe('ACTIVE')
  })

  it('什么都不给 = 兜底试用', () => {
    expect(decideInitialStatus({})).toBe('TRIAL')
    expect(decideInitialStatus({ planId: null, trialDays: null })).toBe('TRIAL')
    expect(decideInitialStatus({ planId: '' })).toBe('TRIAL')
  })
})

describe('resolveTrialDays', () => {
  it('不给就用默认', () => {
    expect(resolveTrialDays(undefined)).toBe(DEFAULT_TRIAL_DAYS)
    expect(resolveTrialDays(null)).toBe(DEFAULT_TRIAL_DAYS)
  })

  it('0 是合法的（今天用完就到期），负数与小数不是', () => {
    expect(resolveTrialDays(0)).toBe(0)
    expect(() => resolveTrialDays(-1)).toThrow(/非负整数/)
    expect(() => resolveTrialDays(1.5)).toThrow(/非负整数/)
  })
})
