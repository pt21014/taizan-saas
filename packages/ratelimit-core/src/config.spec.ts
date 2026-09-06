/**
 * 档位表与 `assertTierSane`。
 *
 * 这一组守的是不变量 6 的后半句：**入口 / 账号维度必须比客户端维度宽松**。
 * 它不是审美偏好——卡紧了就等于把「锁死一片地区」和「锁死指定账号」两个开关
 * 免费送给攻击者，而这两件事的受害者都是什么都没做的人。
 */

import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_LIMIT_FLOOR,
  assertAllTiersSane,
  assertTierSane,
  defineTier,
  EDGE_RATIO_FLOOR,
  findTier,
  isKnownTier,
  RATE_LIMIT_TIER_NAMES,
  RATE_LIMIT_TIERS,
  RateLimitConfigError,
  renderTierMessage,
  type RateLimitTier,
} from './config'

const sane = (overrides: Partial<RateLimitTier> = {}): RateLimitTier => ({
  name: 'test',
  windowSec: 60,
  clientLimit: 10,
  edgeLimit: 200,
  accountLimit: 50,
  counts: 'failures',
  note: '测试用',
  ...overrides,
})

describe('内置档位表', () => {
  it('五个档位齐全', () => {
    expect(RATE_LIMIT_TIER_NAMES.sort()).toEqual(
      ['login', 'lookup', 'public-default', 'signup', 'sms-code'].sort(),
    )
  })

  it('整张表都过 assertTierSane', () => {
    expect(() => assertAllTiersSane()).not.toThrow()
  })

  it('每一档的 edgeLimit 都远大于 clientLimit（否则就是锁死整片地区的开关）', () => {
    for (const [name, tier] of Object.entries(RATE_LIMIT_TIERS)) {
      expect(tier.edgeLimit, `${name} 的 edgeLimit 偏低`).toBeGreaterThan(
        tier.clientLimit * EDGE_RATIO_FLOOR,
      )
    }
  })

  it('账号维度要么达到下限，要么写了书面理由——不许两者都没有', () => {
    for (const [name, tier] of Object.entries(RATE_LIMIT_TIERS)) {
      if (tier.accountLimit === undefined) continue
      if (tier.accountLimit >= ACCOUNT_LIMIT_FLOOR) continue
      expect(
        tier.accountFloorExemptReason?.length ?? 0,
        `${name} 低于下限却没写理由`,
      ).toBeGreaterThan(10)
    }
  })

  it('唯一一个走豁免的是 signup，且理由说清了「这里的账号是手机号、计的是建了几家店」', () => {
    const exempt = Object.values(RATE_LIMIT_TIERS).filter((t) => t.accountFloorExemptReason)
    expect(exempt.map((t) => t.name)).toEqual(['signup'])
    expect(RATE_LIMIT_TIERS.signup.accountFloorExemptReason).toContain('手机号')
  })

  it('signup 与 lookup 按「请求数」计——成功也要计数', () => {
    // 只算失败的话，真正要拦的那种行为（每次都成功地建出一家店 / 每次都查到一个人）
    // 反而一次额度都不消耗，正好把要拦的放过去了。
    expect(RATE_LIMIT_TIERS.signup.counts).toBe('requests')
    expect(RATE_LIMIT_TIERS.lookup.counts).toBe('requests')
  })

  it('login 按「失败数」计，且触顶文案讲的是失败', () => {
    expect(RATE_LIMIT_TIERS.login.counts).toBe('failures')
    expect(RATE_LIMIT_TIERS.login.message).toContain('失败')
  })

  it('按请求数计的档位，触顶文案里不能说「失败」', () => {
    // 一个连查三十次、一次也没错的人被告知「失败次数过多」，
    // 他会以为是自己输错了，然后再试几遍。
    for (const tier of Object.values(RATE_LIMIT_TIERS)) {
      if (tier.counts !== 'requests') continue
      expect(tier.message ?? '', `${tier.name} 的文案`).not.toContain('失败')
    }
  })

  it('findTier / isKnownTier 对拼错的档位名回 undefined / false，而不是兜底放行', () => {
    expect(findTier('login')).toBeDefined()
    expect(findTier('1ogin')).toBeUndefined()
    expect(isKnownTier('sms-code')).toBe(true)
    expect(isKnownTier('sms')).toBe(false)
  })
})

describe('assertTierSane', () => {
  it('正常配置不抛', () => {
    expect(() => assertTierSane(sane())).not.toThrow()
  })

  it('edgeLimit 不到 clientLimit 的 5 倍就抛，且报错里说清了后果', () => {
    expect(() => assertTierSane(sane({ clientLimit: 10, edgeLimit: 50 }))).toThrow(
      RateLimitConfigError,
    )
    expect(() => assertTierSane(sane({ clientLimit: 10, edgeLimit: 50 }))).toThrow(
      /整个城市|一整个城市|地区/,
    )
  })

  it('edgeLimit 恰好等于 5 倍也不行（要求严格大于）', () => {
    expect(() => assertTierSane(sane({ clientLimit: 10, edgeLimit: 50 }))).toThrow()
    expect(() => assertTierSane(sane({ clientLimit: 10, edgeLimit: 51 }))).not.toThrow()
  })

  it('accountLimit 比 clientLimit 还小就抛——那意味着受害的是被攻击的账号', () => {
    expect(() => assertTierSane(sane({ clientLimit: 10, accountLimit: 5 }))).toThrow(/什么也没做/)
  })

  it('accountLimit 低于下限且没写理由就抛', () => {
    expect(() => assertTierSane(sane({ clientLimit: 3, edgeLimit: 60, accountLimit: 5 }))).toThrow(
      /accountFloorExemptReason/,
    )
  })

  it('理由太短（`// TODO` 这种）不算理由', () => {
    expect(() =>
      assertTierSane(
        sane({ clientLimit: 3, edgeLimit: 60, accountLimit: 5, accountFloorExemptReason: 'TODO' }),
      ),
    ).toThrow()
  })

  it('写了足够长的理由就放过', () => {
    expect(() =>
      assertTierSane(
        sane({
          clientLimit: 3,
          edgeLimit: 60,
          accountLimit: 5,
          accountFloorExemptReason: '这里的账号是手机号，计的是今天建了几家店，不是试了几次口令',
        }),
      ),
    ).not.toThrow()
  })

  it('不配 accountLimit 是合法的（这条路上没有账号概念）', () => {
    expect(() => assertTierSane(sane({ accountLimit: undefined }))).not.toThrow()
  })

  it.each([
    ['windowSec 为 0（计数永不过期，被拦的人永远解不了封）', { windowSec: 0 }],
    ['clientLimit 为 0（所有人一律拒绝）', { clientLimit: 0 }],
    ['edgeLimit 为负', { edgeLimit: -1 }],
    ['clientLimit 是小数', { clientLimit: 2.5 }],
  ])('%s 直接抛', (_label, overrides) => {
    expect(() => assertTierSane(sane(overrides as Partial<RateLimitTier>))).toThrow(
      RateLimitConfigError,
    )
  })
})

describe('defineTier / renderTierMessage', () => {
  it('defineTier 在定义时就校验，写歪了 import 阶段就炸', () => {
    expect(() => defineTier(sane({ name: 'biz', edgeLimit: 11 }))).toThrow(RateLimitConfigError)
  })

  it('defineTier 返回冻结对象，防止运行时被改小', () => {
    const tier = defineTier(sane({ name: 'biz' }))
    expect(Object.isFrozen(tier)).toBe(true)
  })

  it('{sec} 被换成真实秒数', () => {
    expect(renderTierMessage(RATE_LIMIT_TIERS.login, 42)).toContain('42')
    expect(renderTierMessage(RATE_LIMIT_TIERS.login, 42)).not.toContain('{sec}')
  })

  it('没写 message 的档位用默认文案', () => {
    expect(renderTierMessage(RATE_LIMIT_TIERS['public-default'], 7)).toBe(
      '请求太频繁了，请 7 秒后再试',
    )
  })
})
