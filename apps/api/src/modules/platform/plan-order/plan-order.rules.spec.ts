/**
 * `plan-order.rules.ts` 的单测。
 *
 * 这批断言的对象是「钱」和「状态机」，所以写法上刻意**穷举**而不是抽样：
 * 状态迁移表是 5×5 全遍历，金额是三档边界各一条。抽样测状态机的问题是
 * 漏掉的那条边永远不会被发现——直到有人在生产上走了它。
 */

import { describe, expect, it } from 'vitest'

import {
  assertTransition,
  canTransition,
  computeFulfillPeriod,
  computeOrderAmount,
  isAmountMatch,
  isTimedOut,
  nextTenantStatus,
  PLAN_ORDER_TIMEOUT_MS,
  PLAN_ORDER_TRANSITIONS,
  PlanOrderTransitionError,
  resolveOrderType,
  timeoutCutoff,
  type PlanOrderStatus,
} from './plan-order.rules'

const ALL: readonly PlanOrderStatus[] = ['PENDING', 'PAID', 'FULFILLED', 'CANCELLED', 'REFUNDED']

/** 蓝图 §4.6 那张图上的三条边，一条不多一条不少。 */
const LEGAL: ReadonlyArray<[PlanOrderStatus, PlanOrderStatus]> = [
  ['PENDING', 'PAID'],
  ['PENDING', 'CANCELLED'],
  ['PAID', 'FULFILLED'],
  ['FULFILLED', 'REFUNDED'],
]

describe('状态迁移表', () => {
  it('5×5 全遍历：只有蓝图那四条边合法，其余 21 条一律拒绝', () => {
    const allowed: string[] = []
    for (const from of ALL) {
      for (const to of ALL) {
        if (canTransition(from, to)) allowed.push(`${from}->${to}`)
      }
    }
    expect(allowed.sort()).toEqual(LEGAL.map(([f, t]) => `${f}->${t}`).sort())
  })

  it('CANCELLED / REFUNDED 是终态（一条出边都没有）', () => {
    expect(PLAN_ORDER_TRANSITIONS.CANCELLED).toEqual([])
    expect(PLAN_ORDER_TRANSITIONS.REFUNDED).toEqual([])
  })

  it('CANCELLED 不能复活成 PAID——超时取消之后钱才到账要走人工核销 + 原路退款', () => {
    expect(canTransition('CANCELLED', 'PAID')).toBe(false)
    expect(canTransition('CANCELLED', 'FULFILLED')).toBe(false)
  })

  it('PAID 不能被取消（钱都收了不能一取了之），只能往 FULFILLED 走', () => {
    expect(canTransition('PAID', 'CANCELLED')).toBe(false)
    expect(PLAN_ORDER_TRANSITIONS.PAID).toEqual(['FULFILLED'])
  })

  it('自环一律不合法（重复兑现要靠状态判断挡在前面，不是靠 FULFILLED->FULFILLED 放行）', () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false)
  })

  it('assertTransition 合法时静默、非法时抛 PlanOrderTransitionError 且报错写清下一步', () => {
    expect(() => assertTransition('PENDING', 'PAID')).not.toThrow()
    expect(() => assertTransition('FULFILLED', 'PAID')).toThrow(PlanOrderTransitionError)
    try {
      assertTransition('CANCELLED', 'FULFILLED')
    } catch (err) {
      expect((err as Error).message).toContain('无，这是终态')
    }
  })
})

describe('金额计算', () => {
  const prices = { firstPriceCents: 19900, renewPriceCents: 9900 }

  it('首购按 firstPriceCents，续费按 renewPriceCents', () => {
    expect(computeOrderAmount({ ...prices, periods: 1, hasFulfilledBefore: false })).toBe(19900)
    expect(computeOrderAmount({ ...prices, periods: 1, hasFulfilledBefore: true })).toBe(9900)
  })

  it('周期数直接乘上去', () => {
    expect(computeOrderAmount({ ...prices, periods: 12, hasFulfilledBefore: true })).toBe(118800)
  })

  it('0 元套餐是合法的（内测/赠送档），负价不是', () => {
    expect(
      computeOrderAmount({
        firstPriceCents: 0,
        renewPriceCents: 0,
        periods: 3,
        hasFulfilledBefore: false,
      }),
    ).toBe(0)
    expect(() =>
      computeOrderAmount({
        firstPriceCents: -1,
        renewPriceCents: 0,
        periods: 1,
        hasFulfilledBefore: false,
      }),
    ).toThrow(RangeError)
  })

  it('periods 必须是正整数（0 / 小数 / 负数都拒）', () => {
    for (const periods of [0, -1, 1.5, Number.NaN]) {
      expect(() => computeOrderAmount({ ...prices, periods, hasFulfilledBefore: true })).toThrow(
        RangeError,
      )
    }
  })
})

describe('订单类型', () => {
  it('没兑现过 = OPEN，即便平台后台已经先挂了套餐', () => {
    expect(
      resolveOrderType({ hasFulfilledBefore: false, currentPlanId: 'p1', targetPlanId: 'p1' }),
    ).toBe('OPEN')
  })

  it('兑现过 + 同一档 = RENEW；兑现过 + 换档 = UPGRADE', () => {
    expect(
      resolveOrderType({ hasFulfilledBefore: true, currentPlanId: 'p1', targetPlanId: 'p1' }),
    ).toBe('RENEW')
    expect(
      resolveOrderType({ hasFulfilledBefore: true, currentPlanId: 'p1', targetPlanId: 'p2' }),
    ).toBe('UPGRADE')
  })

  it('兑现过但当前没挂套餐（被平台清过）= RENEW，不是 UPGRADE', () => {
    expect(
      resolveOrderType({ hasFulfilledBefore: true, currentPlanId: null, targetPlanId: 'p2' }),
    ).toBe('RENEW')
  })
})

describe('超时取消', () => {
  const now = new Date('2026-03-10T10:00:00.000Z')

  it('30 分钟是分界线，cutoff 就是 now - 30min', () => {
    expect(PLAN_ORDER_TIMEOUT_MS).toBe(1_800_000)
    expect(timeoutCutoff(now).toISOString()).toBe('2026-03-10T09:30:00.000Z')
  })

  it('恰好 30 分钟不算超时（边界含在存活侧），30 分零 1 毫秒算', () => {
    expect(isTimedOut(new Date(now.getTime() - PLAN_ORDER_TIMEOUT_MS), now)).toBe(false)
    expect(isTimedOut(new Date(now.getTime() - PLAN_ORDER_TIMEOUT_MS - 1), now)).toBe(true)
  })

  it('刚下的单不超时', () => {
    expect(isTimedOut(now, now)).toBe(false)
  })
})

describe('履约后的到期日', () => {
  it('提前续：从原到期日往后加，不吞掉未享受的天数', () => {
    const res = computeFulfillPeriod({
      currentExpireAt: new Date('2026-06-30T15:59:59.999Z'), // 2026-06-30 23:59:59.999 +08
      now: new Date('2026-06-01T00:00:00.000Z'),
      periods: 1,
      periodMonths: 12,
    })
    expect(res.expireBeforeAt?.toISOString()).toBe('2026-06-30T15:59:59.999Z')
    expect(res.expireAfterAt.toISOString()).toBe('2027-06-30T15:59:59.999Z')
  })

  it('断供后回来：从今天起算，买完立刻是未到期状态', () => {
    const res = computeFulfillPeriod({
      currentExpireAt: new Date('2026-01-01T00:00:00.000Z'),
      now: new Date('2026-06-10T03:00:00.000Z'), // 2026-06-10 11:00 +08
      periods: 1,
      periodMonths: 1,
    })
    expect(res.expireAfterAt.getTime()).toBeGreaterThan(new Date('2026-07-10T00:00:00Z').getTime())
  })

  it('从未开通过（currentExpireAt = null）也能算，expireBeforeAt 原样回 null', () => {
    const res = computeFulfillPeriod({
      currentExpireAt: null,
      now: new Date('2026-06-10T03:00:00.000Z'),
      periods: 2,
      periodMonths: 1,
    })
    expect(res.expireBeforeAt).toBeNull()
    expect(res.expireAfterAt.toISOString()).toBe('2026-08-10T15:59:59.999Z')
  })
})

describe('回调金额比对与租户状态', () => {
  it('分不差才算一致', () => {
    expect(isAmountMatch(9900, 9900)).toBe(true)
    expect(isAmountMatch(9900, 9899)).toBe(false)
    expect(isAmountMatch(9900, 1)).toBe(false)
  })

  it('TRIAL 付款后转 ACTIVE；ACTIVE / SUSPENDED / DEREGISTERED 都不动', () => {
    expect(nextTenantStatus('TRIAL')).toBe('ACTIVE')
    expect(nextTenantStatus('ACTIVE')).toBeNull()
    expect(nextTenantStatus('SUSPENDED')).toBeNull()
    expect(nextTenantStatus('DEREGISTERED')).toBeNull()
  })
})
