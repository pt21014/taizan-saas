/**
 * `BILLING_ENV_SHAPE` 与 nest-core 的 `BASE_ENV_SHAPE.BILLING_ENFORCE` 是两份同形状的
 * 副本（理由见 `env.ts` 文件头）。这个 spec 就是那两份的对账：
 * 哪天有一份被改跑偏，这里先红，而不是等到线上「以为在收钱其实没收」。
 */

import { BASE_ENV_SHAPE } from '@taizan/nest-core'
import { describe, expect, it } from 'vitest'
import { BILLING_ENV_SCHEMA } from './env'
import { readEnforceFromEnv } from './billing.options'

const TRUTHY = ['1', 'true', 'TRUE', 'yes', 'on']
const FALSY = ['0', 'false', 'no', 'off']

describe('BILLING_ENV_SHAPE', () => {
  it('缺省是 false——「默认关」是蓝图 §4.5 的第四条不可退让', () => {
    expect(BILLING_ENV_SCHEMA.parse({}).BILLING_ENFORCE).toBe(false)
    expect(BILLING_ENV_SCHEMA.parse({ BILLING_ENFORCE: '' }).BILLING_ENFORCE).toBe(false)
  })

  it.each(TRUTHY)('%s 解析成 true', (raw) => {
    expect(BILLING_ENV_SCHEMA.parse({ BILLING_ENFORCE: raw }).BILLING_ENFORCE).toBe(true)
  })

  it.each(FALSY)('%s 解析成 false', (raw) => {
    expect(BILLING_ENV_SCHEMA.parse({ BILLING_ENFORCE: raw }).BILLING_ENFORCE).toBe(false)
  })

  it('拼错时报错而不是静默变 false（BILLING_ENFORCE=ture）', () => {
    expect(() => BILLING_ENV_SCHEMA.parse({ BILLING_ENFORCE: 'ture' })).toThrow()
  })

  it('与 nest-core 的 BASE_ENV_SHAPE.BILLING_ENFORCE 对同一批输入结论一致', () => {
    const base = BASE_ENV_SHAPE.BILLING_ENFORCE
    const mine = BILLING_ENV_SCHEMA.shape.BILLING_ENFORCE
    for (const raw of [...TRUTHY, ...FALSY, '', undefined]) {
      expect(mine.safeParse(raw)).toEqual(base.safeParse(raw))
    }
    expect(mine.safeParse('ture').success).toBe(base.safeParse('ture').success)
  })
})

describe('readEnforceFromEnv：运行期兜底', () => {
  it('未设置就是 false', () => {
    expect(readEnforceFromEnv({})).toBe(false)
  })

  it.each(TRUTHY)('%s 为真', (raw) => {
    expect(readEnforceFromEnv({ BILLING_ENFORCE: raw })).toBe(true)
  })

  it('拼错时当假——这里是兜底，拒启由 zod schema 负责', () => {
    expect(readEnforceFromEnv({ BILLING_ENFORCE: 'ture' })).toBe(false)
  })
})
