import { isUlid } from '@taizan/contracts'
import { describe, expect, it } from 'vitest'

import { PAYMENT_ERROR, PaymentError } from './errors'
import {
  OUT_TRADE_NO_MAX_LEN,
  OutTradeNoRouter,
  PLAN_ORDER_PREFIX,
  buildOutTradeNo,
  parseOutTradeNo,
} from './out-trade-no'

describe('buildOutTradeNo', () => {
  it('生成 PREFIX-ULID，id 段是合法 ULID', () => {
    const no = buildOutTradeNo(PLAN_ORDER_PREFIX)
    expect(no.startsWith('PLAN-')).toBe(true)
    expect(isUlid(no.slice('PLAN-'.length))).toBe(true)
  })

  it('自动生成时总长 31 位，卡在 32 的上限之内', () => {
    // ULID 固定 26 位 + 分隔符 1 位 + 'PLAN' 4 位 = 31
    expect(buildOutTradeNo(PLAN_ORDER_PREFIX)).toHaveLength(31)
    expect(buildOutTradeNo(PLAN_ORDER_PREFIX).length).toBeLessThanOrEqual(OUT_TRADE_NO_MAX_LEN)
  })

  it('5 位前缀是自动生成的临界值：5 位刚好 32，6 位就超了', () => {
    expect(buildOutTradeNo('ABCDE')).toHaveLength(OUT_TRADE_NO_MAX_LEN)
    // 6 位前缀本身合规（parse 认它），但配 26 位 ULID 必然超长——
    // 报错要说清是长度超了，而不是笼统一句「前缀不合规」
    expect(() => buildOutTradeNo('ABCDEF')).toThrow(/长度 33 超过上限 32/)
  })

  it('自带短 id 时，6 位前缀可用', () => {
    expect(buildOutTradeNo('REFUND', 'A1B2C3')).toBe('REFUND-A1B2C3')
  })

  it('前缀只收 1–6 位大写字母与数字', () => {
    expect(() => buildOutTradeNo('')).toThrow(/前缀/)
    expect(() => buildOutTradeNo('plan')).toThrow(/前缀/)
    expect(() => buildOutTradeNo('PL_AN')).toThrow(/前缀/)
    expect(() => buildOutTradeNo('ABCDEFG', 'X')).toThrow(/前缀/)
    expect(buildOutTradeNo('P1', 'X')).toBe('P1-X')
  })

  it('id 段不能含分隔符——否则 parse 会切错位置', () => {
    expect(() => buildOutTradeNo('PLAN', 'A-B')).toThrow(/id 段/)
  })

  it('抛的是带 16 域段错误码的 PaymentError', () => {
    try {
      buildOutTradeNo('bad')
      expect.unreachable('应该抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentError)
      expect((e as PaymentError).code).toBe(PAYMENT_ERROR.BAD_REQUEST.code)
    }
  })
})

describe('parseOutTradeNo', () => {
  it('与 buildOutTradeNo 往返一致', () => {
    const no = buildOutTradeNo(PLAN_ORDER_PREFIX)
    const { prefix, id } = parseOutTradeNo(no)
    expect(prefix).toBe(PLAN_ORDER_PREFIX)
    expect(`${prefix}-${id}`).toBe(no)
  })

  it('按第一个分隔符切分', () => {
    expect(parseOutTradeNo('PLAN-ABC')).toEqual({ prefix: 'PLAN', id: 'ABC' })
  })

  it('不合规时抛错而不是返回 null——静默的话会一路飘到业务层才炸', () => {
    expect(() => parseOutTradeNo('')).toThrow(/为空/)
    expect(() => parseOutTradeNo('NOSEP')).toThrow(/缺少分隔符/)
    expect(() => parseOutTradeNo('plan-abc')).toThrow(/前缀/)
    expect(() => parseOutTradeNo('PLAN-')).toThrow(/id 段/)
    expect(() => parseOutTradeNo('PLAN-A_B')).toThrow(/id 段/)
    expect(() => parseOutTradeNo(`PLAN-${'X'.repeat(30)}`)).toThrow(/超过 32/)
  })
})

describe('OutTradeNoRouter', () => {
  const handlerA = () => 'A'
  const handlerB = () => 'B'

  it('按前缀分发，并把解析结果一起给出来', () => {
    const router = new OutTradeNoRouter<() => string>()
    router.register(PLAN_ORDER_PREFIX, handlerA)
    const routed = router.route('PLAN-01H0')
    expect(routed.prefix).toBe('PLAN')
    expect(routed.id).toBe('01H0')
    expect(routed.handler()).toBe('A')
  })

  it('重复前缀直接抛，不是后者覆盖前者——覆盖的表现是「钱收了、货发错了」', () => {
    const router = new OutTradeNoRouter<() => string>()
    router.register('PLAN', handlerA)
    expect(() => router.register('PLAN', handlerB)).toThrow(/已经注册过/)
    // 抛错之后，原来的处理器必须还在
    expect(router.route('PLAN-1').handler()).toBe('A')
  })

  it('注册时也校验前缀合规性', () => {
    const router = new OutTradeNoRouter<() => string>()
    expect(() => router.register('plan', handlerA)).toThrow(/前缀/)
  })

  it('前缀没注册时抛 ROUTE_NOT_FOUND，并把已注册的列出来便于排障', () => {
    const router = new OutTradeNoRouter<() => string>()
    router.register('PLAN', handlerA)
    try {
      router.route('SHOP-1')
      expect.unreachable('应该抛错')
    } catch (e) {
      expect((e as PaymentError).code).toBe(PAYMENT_ERROR.ROUTE_NOT_FOUND.code)
      expect((e as Error).message).toContain('PLAN')
    }
  })

  it('tryRoute 对未注册前缀返回 null，但单号本身不合规仍然抛', () => {
    const router = new OutTradeNoRouter<() => string>()
    router.register('PLAN', handlerA)
    expect(router.tryRoute('SHOP-1')).toBeNull()
    expect(router.tryRoute('PLAN-1')?.handler()).toBe('A')
    expect(() => router.tryRoute('bad')).toThrow()
  })

  it('has / prefixes 反映注册表', () => {
    const router = new OutTradeNoRouter<() => string>()
    router.register('PLAN', handlerA).register('SHOP', handlerB)
    expect(router.has('PLAN')).toBe(true)
    expect(router.has('NOPE')).toBe(false)
    expect(router.prefixes()).toEqual(['PLAN', 'SHOP'])
  })
})
