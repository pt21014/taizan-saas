import { describe, expect, it } from 'vitest'
import {
  assertNoDevCodeInProd,
  DevCodeInProductionError,
  warnIfBillingNotEnforcedInProd,
} from './assert-no-dev-code'

describe('assertNoDevCodeInProd', () => {
  // 用例②
  it('production + SMS_RETURN_DEV_CODE=1 → 拒启', () => {
    let caught: unknown
    try {
      assertNoDevCodeInProd({ NODE_ENV: 'production', SMS_RETURN_DEV_CODE: '1' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DevCodeInProductionError)
    const err = caught as DevCodeInProductionError
    expect(err.violations).toHaveLength(1)
    expect(err.message).toContain('SMS_RETURN_DEV_CODE')
    // 报错要说清后果，不能只说「不允许」
    expect(err.message).toContain('任意手机号免验证登录')
    expect(err.message).toContain('生产环境')
  })

  it('布尔 true 与字符串 true/yes/on 都算开启', () => {
    for (const value of [true, 'true', 'TRUE', 'yes', 'on', 1]) {
      expect(() =>
        assertNoDevCodeInProd({ NODE_ENV: 'production', WECHAT_DEV_FAKE_LOGIN: value }),
      ).toThrow(DevCodeInProductionError)
    }
  })

  it('两个开关都开时一次性列出两条', () => {
    try {
      assertNoDevCodeInProd({
        NODE_ENV: 'production',
        SMS_RETURN_DEV_CODE: true,
        WECHAT_DEV_FAKE_LOGIN: true,
      })
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as DevCodeInProductionError).violations).toHaveLength(2)
    }
  })

  it('非生产环境放行', () => {
    expect(() =>
      assertNoDevCodeInProd({ NODE_ENV: 'development', SMS_RETURN_DEV_CODE: true }),
    ).not.toThrow()
    expect(() =>
      assertNoDevCodeInProd({ NODE_ENV: 'test', WECHAT_DEV_FAKE_LOGIN: true }),
    ).not.toThrow()
  })

  it('生产环境但开关都关时放行', () => {
    expect(() =>
      assertNoDevCodeInProd({
        NODE_ENV: 'production',
        SMS_RETURN_DEV_CODE: false,
        WECHAT_DEV_FAKE_LOGIN: '0',
      }),
    ).not.toThrow()
  })
})

describe('warnIfBillingNotEnforcedInProd', () => {
  it('生产且未开计费闸门时给告警文本（但不抛错）', () => {
    expect(
      warnIfBillingNotEnforcedInProd({ NODE_ENV: 'production', BILLING_ENFORCE: false }),
    ).toContain('BILLING_ENFORCE')
  })

  it('已开启或非生产时不告警', () => {
    expect(
      warnIfBillingNotEnforcedInProd({ NODE_ENV: 'production', BILLING_ENFORCE: true }),
    ).toBeNull()
    expect(
      warnIfBillingNotEnforcedInProd({ NODE_ENV: 'development', BILLING_ENFORCE: false }),
    ).toBeNull()
  })
})
