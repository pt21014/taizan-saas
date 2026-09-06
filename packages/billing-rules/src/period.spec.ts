import { describe, expect, it } from 'vitest'

import {
  DAY_MS,
  DEFAULT_TIMEZONE,
  MAX_PERIODS_PER_ORDER,
  addCalendarDays,
  addCalendarMonths,
  calendarDayOf,
  computeRefundRollback,
  computeRenewal,
  computeTrialEnd,
  daysInMonth,
  diffCalendarDays,
  endOfCalendarDay,
  endOfDayInZone,
  startOfCalendarDay,
  zonedParts,
} from './period'

/** 东八区墙上时间 → Date。 */
function sh(wall: string): Date {
  return new Date(`${wall.replace(' ', 'T')}+08:00`)
}

/** 东八区当天最后一刻的 ISO 串，用来写期望值。 */
function shEnd(day: string): string {
  return sh(`${day} 23:59:59.999`).toISOString()
}

describe('常量', () => {
  it('默认时区是 Asia/Shanghai', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Shanghai')
  })

  it('DAY_MS 是 86400000', () => {
    expect(DAY_MS).toBe(86_400_000)
  })

  it('MAX_PERIODS_PER_ORDER 是正整数护栏', () => {
    expect(Number.isInteger(MAX_PERIODS_PER_ORDER)).toBe(true)
    expect(MAX_PERIODS_PER_ORDER).toBeGreaterThan(0)
  })
})

describe('zonedParts / calendarDayOf', () => {
  it('按指定时区拆出墙上时间，不看进程时区', () => {
    expect(zonedParts(new Date('2026-03-10T16:30:45.000Z'), 'Asia/Shanghai')).toEqual({
      year: 2026,
      month: 3,
      day: 11,
      hour: 0,
      minute: 30,
      second: 45,
    })
  })

  it('UTC 时区拆出的就是 UTC 分量', () => {
    expect(zonedParts(new Date('2026-03-10T16:30:45.000Z'), 'UTC')).toMatchObject({
      day: 10,
      hour: 16,
    })
  })

  it('午夜用 00 而不是 24（hourCycle h23）', () => {
    expect(zonedParts(new Date('2026-03-10T16:00:00.000Z'), 'Asia/Shanghai').hour).toBe(0)
  })

  it('calendarDayOf 只取年月日', () => {
    expect(calendarDayOf(sh('2026-03-10 23:59:59'))).toEqual({ year: 2026, month: 3, day: 10 })
  })

  it('calendarDayOf 跨时区会落在不同的日历日', () => {
    const t = new Date('2026-03-10T16:30:00.000Z')
    expect(calendarDayOf(t, 'Asia/Shanghai').day).toBe(11)
    expect(calendarDayOf(t, 'UTC').day).toBe(10)
  })

  it('Invalid Date 抛 TypeError', () => {
    expect(() => zonedParts(new Date('nope'))).toThrow(TypeError)
  })

  it('非法时区抛 RangeError', () => {
    expect(() => zonedParts(new Date(), 'Nowhere/Nothing')).toThrow(RangeError)
  })
})

describe('daysInMonth', () => {
  it('2024 年 2 月有 29 天（闰年）', () => {
    expect(daysInMonth(2024, 2)).toBe(29)
  })

  it('2026 年 2 月有 28 天', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
  })

  it('2100 年 2 月有 28 天（整百不闰）', () => {
    expect(daysInMonth(2100, 2)).toBe(28)
  })

  it('2000 年 2 月有 29 天（四百年闰）', () => {
    expect(daysInMonth(2000, 2)).toBe(29)
  })

  it('4 月有 30 天', () => {
    expect(daysInMonth(2026, 4)).toBe(30)
  })

  it('12 月有 31 天', () => {
    expect(daysInMonth(2026, 12)).toBe(31)
  })
})

describe('addCalendarMonths / 月末夹逼', () => {
  it('1/31 + 1 个月 = 2/28', () => {
    expect(addCalendarMonths({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    })
  })

  it('闰年 1/31 + 1 个月 = 2/29', () => {
    expect(addCalendarMonths({ year: 2024, month: 1, day: 31 }, 1)).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    })
  })

  it('1/31 + 3 个月 = 4/30', () => {
    expect(addCalendarMonths({ year: 2026, month: 1, day: 31 }, 3)).toMatchObject({
      month: 4,
      day: 30,
    })
  })

  it('1/31 + 2 个月 = 3/31（一次性加，不做两次夹逼）', () => {
    expect(addCalendarMonths({ year: 2026, month: 1, day: 31 }, 2)).toMatchObject({
      month: 3,
      day: 31,
    })
  })

  it('3/31 + 1 个月 = 4/30', () => {
    expect(addCalendarMonths({ year: 2026, month: 3, day: 31 }, 1)).toMatchObject({
      month: 4,
      day: 30,
    })
  })

  it('跨年：12/15 + 1 个月 = 次年 1/15', () => {
    expect(addCalendarMonths({ year: 2026, month: 12, day: 15 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 15,
    })
  })

  it('跨多年：3/1 + 25 个月 = 两年后的 4/1', () => {
    expect(addCalendarMonths({ year: 2026, month: 3, day: 1 }, 25)).toEqual({
      year: 2028,
      month: 4,
      day: 1,
    })
  })

  it('+12 个月保持同月同日', () => {
    expect(addCalendarMonths({ year: 2026, month: 2, day: 28 }, 12)).toEqual({
      year: 2027,
      month: 2,
      day: 28,
    })
  })

  it('闰日 + 12 个月被夹到 2/28', () => {
    expect(addCalendarMonths({ year: 2024, month: 2, day: 29 }, 12)).toEqual({
      year: 2025,
      month: 2,
      day: 28,
    })
  })

  it('+0 不变', () => {
    expect(addCalendarMonths({ year: 2026, month: 5, day: 17 }, 0)).toEqual({
      year: 2026,
      month: 5,
      day: 17,
    })
  })

  it('负数向前推', () => {
    expect(addCalendarMonths({ year: 2026, month: 1, day: 10 }, -2)).toEqual({
      year: 2025,
      month: 11,
      day: 10,
    })
  })

  it('非整数月抛 RangeError', () => {
    expect(() => addCalendarMonths({ year: 2026, month: 1, day: 1 }, 1.5)).toThrow(RangeError)
  })
})

describe('addCalendarDays', () => {
  it('同月内加天', () => {
    expect(addCalendarDays({ year: 2026, month: 3, day: 10 }, 5)).toEqual({
      year: 2026,
      month: 3,
      day: 15,
    })
  })

  it('跨月', () => {
    expect(addCalendarDays({ year: 2026, month: 3, day: 30 }, 3)).toEqual({
      year: 2026,
      month: 4,
      day: 2,
    })
  })

  it('跨年', () => {
    expect(addCalendarDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    })
  })

  it('跨闰日', () => {
    expect(addCalendarDays({ year: 2024, month: 2, day: 28 }, 1)).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    })
  })

  it('+0 不变', () => {
    expect(addCalendarDays({ year: 2026, month: 3, day: 10 }, 0).day).toBe(10)
  })

  it('负数向前推', () => {
    expect(addCalendarDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    })
  })

  it('非整数天抛 RangeError', () => {
    expect(() => addCalendarDays({ year: 2026, month: 3, day: 1 }, 0.5)).toThrow(RangeError)
  })
})

describe('endOfCalendarDay / startOfCalendarDay / endOfDayInZone', () => {
  it('东八区当天末是次日 15:59:59.999Z', () => {
    expect(endOfCalendarDay({ year: 2026, month: 3, day: 10 }).toISOString()).toBe(
      '2026-03-10T15:59:59.999Z',
    )
  })

  it('东八区当天初是前一日 16:00:00.000Z', () => {
    expect(startOfCalendarDay({ year: 2026, month: 3, day: 10 }).toISOString()).toBe(
      '2026-03-09T16:00:00.000Z',
    )
  })

  it('UTC 当天末就是当日 23:59:59.999Z', () => {
    expect(endOfCalendarDay({ year: 2026, month: 3, day: 10 }, 'UTC').toISOString()).toBe(
      '2026-03-10T23:59:59.999Z',
    )
  })

  it('endOfDayInZone 把任意时刻推到当天末', () => {
    expect(endOfDayInZone(sh('2026-03-10 00:00:01')).toISOString()).toBe(shEnd('2026-03-10'))
  })

  it('endOfDayInZone 对已经在当天末的时刻是幂等的', () => {
    const t = endOfDayInZone(sh('2026-03-10 08:00:00'))
    expect(endOfDayInZone(t).toISOString()).toBe(t.toISOString())
  })

  it('endOfDayInZone 跨时区落在不同瞬间', () => {
    const t = new Date('2026-03-10T12:00:00.000Z')
    expect(endOfDayInZone(t, 'Asia/Shanghai').toISOString()).toBe('2026-03-10T15:59:59.999Z')
    expect(endOfDayInZone(t, 'UTC').toISOString()).toBe('2026-03-10T23:59:59.999Z')
  })

  it('落到 23:59:59.999 而不是 .000（当天整天都算未到期）', () => {
    expect(endOfDayInZone(sh('2026-03-10 08:00:00')).getMilliseconds()).toBe(999)
  })

  it('美东夏令时期间的当天末（-04:00）', () => {
    expect(
      endOfCalendarDay({ year: 2026, month: 7, day: 4 }, 'America/New_York').toISOString(),
    ).toBe('2026-07-05T03:59:59.999Z')
  })

  it('美东冬令时期间的当天末（-05:00）', () => {
    expect(
      endOfCalendarDay({ year: 2026, month: 1, day: 4 }, 'America/New_York').toISOString(),
    ).toBe('2026-01-05T04:59:59.999Z')
  })
})

describe('diffCalendarDays', () => {
  it('同一天返回 0', () => {
    expect(diffCalendarDays(sh('2026-03-10 00:00:00'), sh('2026-03-10 23:59:59'))).toBe(0)
  })

  it('次日返回 1', () => {
    expect(diffCalendarDays(sh('2026-03-10 23:00:00'), sh('2026-03-11 01:00:00'))).toBe(1)
  })

  it('前一日返回 -1', () => {
    expect(diffCalendarDays(sh('2026-03-11 01:00:00'), sh('2026-03-10 23:00:00'))).toBe(-1)
  })

  it('跨月正确', () => {
    expect(diffCalendarDays(sh('2026-01-31 12:00:00'), sh('2026-03-01 12:00:00'))).toBe(29)
  })

  it('跨年正确', () => {
    expect(diffCalendarDays(sh('2026-12-31 12:00:00'), sh('2027-01-01 00:00:00'))).toBe(1)
  })

  it('按日历日而不是 24 小时（相差 2 小时也算 1 天）', () => {
    const from = sh('2026-03-10 23:00:00')
    const to = sh('2026-03-11 01:00:00')
    expect(to.getTime() - from.getTime()).toBe(2 * 60 * 60 * 1000)
    expect(diffCalendarDays(from, to)).toBe(1)
  })

  it('时区不同结论不同', () => {
    // 东八区看：3/11 00:30 → 3/11 10:00，同一天；UTC 看：3/10 → 3/11，差一天。
    const from = new Date('2026-03-10T16:30:00.000Z')
    const to = new Date('2026-03-11T02:00:00.000Z')
    expect(diffCalendarDays(from, to, 'Asia/Shanghai')).toBe(0)
    expect(diffCalendarDays(from, to, 'UTC')).toBe(1)
  })
})

describe('computeRenewal / max(原到期日, now) 起算', () => {
  it('原到期日在未来：从原到期日起算（提前续费不吞天数）', () => {
    const r = computeRenewal({
      currentExpireAt: sh('2026-06-30 23:59:59.999'),
      now: sh('2026-03-01 10:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2026-07-30'))
  })

  it('原到期日在过去：从今天起算（断供几个月不该补付）', () => {
    const r = computeRenewal({
      currentExpireAt: sh('2025-06-30 23:59:59.999'),
      now: sh('2026-03-01 10:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2026-04-01'))
  })

  it('原到期日为 null（首次开通）：从今天起算', () => {
    const r = computeRenewal({
      currentExpireAt: null,
      now: sh('2026-03-01 10:00:00'),
      periods: 1,
      periodMonths: 12,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2027-03-01'))
  })

  it('原到期日就是今天：仍从今天起算（当天整天算未到期）', () => {
    const r = computeRenewal({
      currentExpireAt: sh('2026-03-01 08:00:00'),
      now: sh('2026-03-01 22:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2026-04-01'))
  })

  it('原到期日是昨天末：从今天起算', () => {
    const r = computeRenewal({
      currentExpireAt: sh('2026-02-28 23:59:59.999'),
      now: sh('2026-03-01 00:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2026-04-01'))
  })

  it('多 periods：3 × 1 个月 = 加 3 个月', () => {
    const r = computeRenewal({
      currentExpireAt: null,
      now: sh('2026-03-01 10:00:00'),
      periods: 3,
      periodMonths: 1,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2026-06-01'))
  })

  it('periods × periodMonths 相乘：2 × 6 = 12 个月', () => {
    const r = computeRenewal({
      currentExpireAt: null,
      now: sh('2026-03-01 10:00:00'),
      periods: 2,
      periodMonths: 6,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2027-03-01'))
  })

  it('月末：1/31 续 1 个月 → 2/28', () => {
    const r = computeRenewal({
      currentExpireAt: sh('2026-01-31 23:59:59.999'),
      now: sh('2026-01-10 10:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2026-02-28'))
  })

  it('闰年月末：2024-01-31 续 1 个月 → 2024-02-29', () => {
    const r = computeRenewal({
      currentExpireAt: sh('2024-01-31 23:59:59.999'),
      now: sh('2024-01-10 10:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2024-02-29'))
  })

  it('一次性加而不是循环加：1/31 续 2 个月 → 3/31（不是 3/28）', () => {
    const r = computeRenewal({
      currentExpireAt: sh('2026-01-31 23:59:59.999'),
      now: sh('2026-01-10 10:00:00'),
      periods: 2,
      periodMonths: 1,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2026-03-31'))
  })

  it('闰日续 12 个月 → 次年 2/28', () => {
    const r = computeRenewal({
      currentExpireAt: sh('2024-02-29 23:59:59.999'),
      now: sh('2024-02-01 10:00:00'),
      periods: 1,
      periodMonths: 12,
    })
    expect(r.expireAfterAt.toISOString()).toBe(shEnd('2025-02-28'))
  })

  it('新到期日落在当天最后一刻', () => {
    const r = computeRenewal({
      currentExpireAt: null,
      now: sh('2026-03-01 10:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    expect(r.expireAfterAt.getMilliseconds()).toBe(999)
  })

  it('expireBeforeAt 原样回传（null）', () => {
    const r = computeRenewal({
      currentExpireAt: null,
      now: sh('2026-03-01 10:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    expect(r.expireBeforeAt).toBeNull()
  })

  it('expireBeforeAt 原样回传（Date，退款要靠它回退）', () => {
    const before = sh('2026-06-30 23:59:59.999')
    const r = computeRenewal({
      currentExpireAt: before,
      now: sh('2026-03-01 10:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    expect(r.expireBeforeAt?.toISOString()).toBe(before.toISOString())
  })

  it('时区参数生效：UTC 下落在 UTC 当天末', () => {
    const r = computeRenewal({
      currentExpireAt: null,
      now: new Date('2026-03-01T02:00:00.000Z'),
      periods: 1,
      periodMonths: 1,
      timezone: 'UTC',
    })
    expect(r.expireAfterAt.toISOString()).toBe('2026-04-01T23:59:59.999Z')
  })

  it('同一瞬间在东八区可能已经是次日，续期结果差一天', () => {
    const now = new Date('2026-03-01T16:30:00.000Z')
    const utc = computeRenewal({
      currentExpireAt: null,
      now,
      periods: 1,
      periodMonths: 1,
      timezone: 'UTC',
    })
    const cn = computeRenewal({ currentExpireAt: null, now, periods: 1, periodMonths: 1 })
    expect(utc.expireAfterAt.toISOString()).toBe('2026-04-01T23:59:59.999Z')
    expect(cn.expireAfterAt.toISOString()).toBe(shEnd('2026-04-02'))
  })

  it('periods=0 抛 RangeError', () => {
    expect(() =>
      computeRenewal({ currentExpireAt: null, now: new Date(), periods: 0, periodMonths: 1 }),
    ).toThrow(RangeError)
  })

  it('periods 为小数抛', () => {
    expect(() =>
      computeRenewal({ currentExpireAt: null, now: new Date(), periods: 1.5, periodMonths: 1 }),
    ).toThrow(/periods/)
  })

  it('periods 超过上限抛（防把金额乘炸）', () => {
    expect(() =>
      computeRenewal({
        currentExpireAt: null,
        now: new Date(),
        periods: MAX_PERIODS_PER_ORDER + 1,
        periodMonths: 1,
      }),
    ).toThrow(/periods/)
  })

  it('periods 正好等于上限不抛', () => {
    expect(() =>
      computeRenewal({
        currentExpireAt: null,
        now: new Date(),
        periods: MAX_PERIODS_PER_ORDER,
        periodMonths: 1,
      }),
    ).not.toThrow()
  })

  it('periodMonths=0 抛', () => {
    expect(() =>
      computeRenewal({ currentExpireAt: null, now: new Date(), periods: 1, periodMonths: 0 }),
    ).toThrow(/periodMonths/)
  })

  it('now 是 Invalid Date 抛', () => {
    expect(() =>
      computeRenewal({ currentExpireAt: null, now: new Date('nope'), periods: 1, periodMonths: 1 }),
    ).toThrow(TypeError)
  })

  it('currentExpireAt 是 Invalid Date 抛', () => {
    expect(() =>
      computeRenewal({
        currentExpireAt: new Date('nope'),
        now: new Date(),
        periods: 1,
        periodMonths: 1,
      }),
    ).toThrow(/currentExpireAt/)
  })
})

describe('computeTrialEnd', () => {
  it('7 天试用落在第 7 天的当天末', () => {
    expect(computeTrialEnd(sh('2026-03-01 09:00:00'), 7).toISOString()).toBe(shEnd('2026-03-08'))
  })

  it('0 天 = 今天用完就到期，不是立刻到期', () => {
    expect(computeTrialEnd(sh('2026-03-01 09:00:00'), 0).toISOString()).toBe(shEnd('2026-03-01'))
  })

  it('30 天跨月', () => {
    expect(computeTrialEnd(sh('2026-03-15 09:00:00'), 30).toISOString()).toBe(shEnd('2026-04-14'))
  })

  it('跨年', () => {
    expect(computeTrialEnd(sh('2026-12-25 09:00:00'), 10).toISOString()).toBe(shEnd('2027-01-04'))
  })

  it('注册在深夜也落在当天（按东八区，不看进程时区）', () => {
    expect(computeTrialEnd(sh('2026-03-01 23:59:00'), 7).toISOString()).toBe(shEnd('2026-03-08'))
  })

  it('时区参数生效', () => {
    expect(computeTrialEnd(new Date('2026-03-01T20:00:00.000Z'), 0, 'UTC').toISOString()).toBe(
      '2026-03-01T23:59:59.999Z',
    )
  })

  it('负数天数抛 RangeError', () => {
    expect(() => computeTrialEnd(new Date(), -1)).toThrow(RangeError)
  })

  it('小数天数抛', () => {
    expect(() => computeTrialEnd(new Date(), 1.5)).toThrow(/trialDays/)
  })

  it('now 非法抛', () => {
    expect(() => computeTrialEnd(new Date('nope'), 7)).toThrow(TypeError)
  })
})

describe('computeRefundRollback', () => {
  const before = sh('2026-03-31 23:59:59.999')
  const after = sh('2026-04-30 23:59:59.999')

  it('正常退款：回退到 expireBeforeAt', () => {
    const r = computeRefundRollback({
      currentExpireAt: after,
      expireBeforeAt: before,
      expireAfterAt: after,
    })
    expect(r.applied).toBe(true)
    expect(r.expireAt?.toISOString()).toBe(before.toISOString())
  })

  it('重复退款：已经回退过则幂等命中，不再动', () => {
    const r = computeRefundRollback({
      currentExpireAt: before,
      expireBeforeAt: before,
      expireAfterAt: after,
    })
    expect(r).toMatchObject({ applied: false, reason: 'ALREADY_ROLLED_BACK' })
    expect(r.expireAt?.toISOString()).toBe(before.toISOString())
  })

  it('当前到期日已早于 expireBeforeAt：也算已回退', () => {
    const r = computeRefundRollback({
      currentExpireAt: sh('2026-01-01 23:59:59.999'),
      expireBeforeAt: before,
      expireAfterAt: after,
    })
    expect(r.reason).toBe('ALREADY_ROLLED_BACK')
  })

  it('之后又续过费（SUPERSEDED）：不自动回退，交人工核对', () => {
    const r = computeRefundRollback({
      currentExpireAt: sh('2026-08-31 23:59:59.999'),
      expireBeforeAt: before,
      expireAfterAt: after,
    })
    expect(r).toMatchObject({ applied: false, reason: 'SUPERSEDED' })
    expect(r.expireAt?.toISOString()).toBe(sh('2026-08-31 23:59:59.999').toISOString())
  })

  it('首次开通后退款：回退到 null（回到未开通）', () => {
    const r = computeRefundRollback({
      currentExpireAt: after,
      expireBeforeAt: null,
      expireAfterAt: after,
    })
    expect(r).toEqual({ expireAt: null, applied: true })
  })

  it('首次开通退款后再退一次：幂等命中', () => {
    const r = computeRefundRollback({
      currentExpireAt: null,
      expireBeforeAt: null,
      expireAfterAt: after,
    })
    expect(r).toMatchObject({ applied: false, reason: 'ALREADY_ROLLED_BACK' })
  })

  it('边界：currentExpireAt 恰好等于 expireAfterAt 时执行回退', () => {
    expect(
      computeRefundRollback({
        currentExpireAt: after,
        expireBeforeAt: before,
        expireAfterAt: after,
      }).applied,
    ).toBe(true)
  })

  it('边界：currentExpireAt 恰好等于 expireBeforeAt 时不回退', () => {
    expect(
      computeRefundRollback({
        currentExpireAt: before,
        expireBeforeAt: before,
        expireAfterAt: after,
      }).applied,
    ).toBe(false)
  })

  it('expireAfterAt 缺失（老数据）时按可回退处理', () => {
    const r = computeRefundRollback({
      currentExpireAt: after,
      expireBeforeAt: before,
      expireAfterAt: null,
    })
    expect(r.applied).toBe(true)
  })

  it('Invalid Date 抛', () => {
    expect(() =>
      computeRefundRollback({
        currentExpireAt: new Date('nope'),
        expireBeforeAt: before,
        expireAfterAt: after,
      }),
    ).toThrow(TypeError)
  })

  it('computeRenewal 的输出可以直接喂给 computeRefundRollback 完成一个来回', () => {
    const renewal = computeRenewal({
      currentExpireAt: before,
      now: sh('2026-03-10 10:00:00'),
      periods: 1,
      periodMonths: 1,
    })
    const rollback = computeRefundRollback({
      currentExpireAt: renewal.expireAfterAt,
      expireBeforeAt: renewal.expireBeforeAt,
      expireAfterAt: renewal.expireAfterAt,
    })
    expect(rollback.expireAt?.toISOString()).toBe(before.toISOString())
  })
})

describe('computeRenewal / 属性式测试：续费永远只会延后到期日', () => {
  /** 固定种子的 xorshift32，保证 CI 上每次跑的是同一批随机数（随机测试不该是随机红）。 */
  function makeRandom(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s ^= s << 13
      s >>>= 0
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      return s / 0x1_0000_0000
    }
  }

  const zones = ['Asia/Shanghai', 'UTC', 'America/New_York', 'Europe/Berlin']

  it('500 组随机（到期日 × periods × periodMonths × 时区）都满足 after > before 且不缩短', () => {
    const rand = makeRandom(20260305)
    for (let i = 0; i < 500; i += 1) {
      const now = new Date(
        Date.UTC(2024, 0, 1) + Math.floor(rand() * 1500) * DAY_MS + Math.floor(rand() * DAY_MS),
      )
      const offsetDays = Math.floor(rand() * 800) - 400
      const currentExpireAt = rand() < 0.2 ? null : new Date(now.getTime() + offsetDays * DAY_MS)
      const periods = 1 + Math.floor(rand() * 12)
      const periodMonths = 1 + Math.floor(rand() * 12)
      const timezone = zones[Math.floor(rand() * zones.length)]

      const r = computeRenewal({ currentExpireAt, now, periods, periodMonths, timezone })

      // ① 新到期日一定晚于「履约前的到期日」
      if (r.expireBeforeAt !== null) {
        expect(r.expireAfterAt.getTime()).toBeGreaterThan(r.expireBeforeAt.getTime())
      }
      // ② 新到期日一定晚于现在——付了钱不该还是过期状态
      expect(r.expireAfterAt.getTime()).toBeGreaterThan(now.getTime())
      // ③ 续费不会缩短：新到期日不早于原到期日当天的最后一刻
      if (currentExpireAt !== null) {
        expect(r.expireAfterAt.getTime()).toBeGreaterThan(
          endOfDayInZone(currentExpireAt, timezone).getTime(),
        )
      }
      // ④ 永远落在某个日历日的最后一刻
      expect(r.expireAfterAt.getMilliseconds()).toBe(999)
    }
  })

  it('200 组随机：periods 越多到期日越晚（单调递增）', () => {
    const rand = makeRandom(777)
    for (let i = 0; i < 200; i += 1) {
      const now = new Date(Date.UTC(2024, 0, 1) + Math.floor(rand() * 1500) * DAY_MS)
      const currentExpireAt =
        rand() < 0.3 ? null : new Date(now.getTime() + Math.floor(rand() * 200) * DAY_MS)
      const periodMonths = 1 + Math.floor(rand() * 6)
      const a = computeRenewal({ currentExpireAt, now, periods: 1, periodMonths })
      const b = computeRenewal({ currentExpireAt, now, periods: 2, periodMonths })
      expect(b.expireAfterAt.getTime()).toBeGreaterThan(a.expireAfterAt.getTime())
    }
  })

  it('200 组随机：续期结果喂回闸门，续完当场一定不是 EXPIRED', () => {
    const rand = makeRandom(4242)
    for (let i = 0; i < 200; i += 1) {
      const now = new Date(Date.UTC(2024, 0, 1) + Math.floor(rand() * 1500) * DAY_MS)
      const currentExpireAt =
        rand() < 0.5 ? null : new Date(now.getTime() - Math.floor(rand() * 500) * DAY_MS)
      const r = computeRenewal({ currentExpireAt, now, periods: 1, periodMonths: 1 })
      expect(endOfDayInZone(r.expireAfterAt).getTime()).toBeGreaterThanOrEqual(now.getTime())
    }
  })
})
