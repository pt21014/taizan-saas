/**
 * `signup.rules.ts` 的单测。
 *
 * 这三个函数看起来都只有几行，值得测的原因各不相同：
 *
 * - `mapProvisionFailure`：它是「不泄露账号是否存在」这条安全约定的**唯一**落点。
 *   哪天有人为了「提示更友好」把 `OWNER_PASSWORD_REQUIRED` 单独拎出来回一句
 *   「你已经注册过了」，这里立刻红——而线上表现只是「注册页提示变好了」，
 *   没有任何人会觉得那是一次事故。
 * - `resolveSignupTrialDays`：`0` 是**合法值**（先注册后付费），不是「没配」。
 *   用 `configured || DEFAULT` 这种写法会把 0 静默吃掉，而那种 bug 只有运营
 *   把试用期调成 0 的那一天才会暴露。
 * - `isSignupOpen`：`SIGNUP_ENABLED=false` 必须真的关掉，而不是被 `'false'`
 *   这种字符串真值放过去。
 */

import { ErrorCode } from '@taizan/contracts'
import { DEFAULT_TRIAL_DAYS, type ProvisionErrorReason } from '@taizan/provision'
import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_FAILURE,
  isSignupOpen,
  mapProvisionFailure,
  resolveSignupTrialDays,
  SIGNUP_DISABLED,
} from './signup.rules'

/** provision 声明的全部 reason。少一条这里就该补一条断言。 */
const ALL_REASONS: readonly ProvisionErrorReason[] = [
  'SLUG_INVALID',
  'SLUG_RESERVED',
  'SLUG_TAKEN',
  'PHONE_INVALID',
  'NAME_INVALID',
  'OWNER_PASSWORD_REQUIRED',
  'OWNER_PASSWORD_WEAK',
  'OWNER_PASSWORD_MISMATCH',
  'OWNER_ACCOUNT_DISABLED',
  'TRIAL_DAYS_INVALID',
  'PLAN_EXPIRE_REQUIRED',
  'ROLE_PRESET_EMPTY',
  'ROLE_PRESET_MISSING_OWNER',
  'OPERATOR_REQUIRED',
]

describe('mapProvisionFailure：不泄露「这个手机号有没有账号」', () => {
  it('三种凭据类失败回**同一个** code 与**同一句**话', () => {
    const answers = (
      ['OWNER_PASSWORD_REQUIRED', 'OWNER_PASSWORD_MISMATCH', 'OWNER_ACCOUNT_DISABLED'] as const
    ).map((reason) => mapProvisionFailure(reason, `真实原因：${reason}`))

    for (const answer of answers) {
      expect(answer).toEqual(CREDENTIAL_FAILURE)
    }
    // 只要有一条把真实原因漏出去，下面这句就会红。
    expect(new Set(answers.map((a) => `${String(a.code)}|${a.message}`)).size).toBe(1)
    expect(answers[0]?.message).not.toMatch(/注册|存在|停用|账号/)
  })

  it('凭据类失败用 1140100（401 语义 = 回到填口令那一步），不是 1040000', () => {
    expect(CREDENTIAL_FAILURE.code).toBe(1140100)
    expect(CREDENTIAL_FAILURE.code).toBe(ErrorCode.UNAUTHENTICATED.code)
  })

  it('参数类失败落 1040000，且**原样**回 provision 的文案（那些文案本来就写给商家看）', () => {
    for (const reason of [
      'SLUG_INVALID',
      'SLUG_RESERVED',
      'SLUG_TAKEN',
      'PHONE_INVALID',
      'NAME_INVALID',
      'OWNER_PASSWORD_WEAK',
      'TRIAL_DAYS_INVALID',
    ] as const) {
      const answer = mapProvisionFailure(reason, `给商家看的话：${reason}`)
      expect(answer.code, reason).toBe(1040000)
      expect(answer.message, reason).toBe(`给商家看的话：${reason}`)
    }
  })

  it('系统类失败落 1090500，且**不回**原始文案（内部细节不外泄）', () => {
    for (const reason of [
      'ROLE_PRESET_EMPTY',
      'ROLE_PRESET_MISSING_OWNER',
      'PLAN_EXPIRE_REQUIRED',
      'OPERATOR_REQUIRED',
    ] as const) {
      const answer = mapProvisionFailure(reason, 'RolePreset 表里没有 ADMIN 侧的内置角色模板')
      expect(answer.code, reason).toBe(ErrorCode.INTERNAL_ERROR.code)
      expect(answer.message, reason).toBe(ErrorCode.INTERNAL_ERROR.message)
      expect(answer.message).not.toContain('RolePreset')
    }
  })

  it('每一个 reason 都被映射到了三种码之一（新增 reason 忘了归类会红）', () => {
    const allowed = new Set([1040000, 1140100, ErrorCode.INTERNAL_ERROR.code])
    for (const reason of ALL_REASONS) {
      expect(allowed.has(mapProvisionFailure(reason, 'x').code), reason).toBe(true)
    }
  })

  it('没有任何 reason 会把「弱口令」映射成凭据类失败——那会变成一个探针', () => {
    // 服务层在进事务之前已经用同一个 assertOwnerPasswordPolicy 判过 password 了，
    // 所以 OWNER_PASSWORD_WEAK 必须是「参数错」而不是「手机号或密码不对」。
    expect(mapProvisionFailure('OWNER_PASSWORD_WEAK', '密码 8–64 位').code).toBe(1040000)
  })
})

describe('resolveSignupTrialDays', () => {
  it('0 是合法值（先注册后付费），不能被当成「没配」吃掉', () => {
    expect(resolveSignupTrialDays(0)).toBe(0)
  })

  it('正整数原样用', () => {
    expect(resolveSignupTrialDays(7)).toBe(7)
    expect(resolveSignupTrialDays(30)).toBe(30)
  })

  it('负数 / 小数 / NaN / undefined / 空串一律回落到 provision 的默认值', () => {
    for (const bad of [-1, 1.5, Number.NaN, undefined, null, '', 'abc', {}]) {
      expect(resolveSignupTrialDays(bad), JSON.stringify(bad)).toBe(DEFAULT_TRIAL_DAYS)
    }
  })

  it('数字字符串也认（env 直读时是字符串）', () => {
    expect(resolveSignupTrialDays('21')).toBe(21)
  })
})

describe('isSignupOpen', () => {
  it('只有布尔 true 才算开', () => {
    expect(isSignupOpen(true)).toBe(true)
  })

  it('false / 字符串 "false" / undefined 一律算关（字符串真值不能把开关放过去）', () => {
    for (const value of [false, 'false', 'true', '1', 0, 1, undefined, null]) {
      expect(isSignupOpen(value), JSON.stringify(value)).toBe(false)
    }
  })

  it('关掉时回 1040000 而不是 404——路由确实存在，只是这会儿不开放', () => {
    expect(SIGNUP_DISABLED.code).toBe(1040000)
    expect(SIGNUP_DISABLED.message).toContain('自助注册')
  })
})
