import { describe, expect, it } from 'vitest'

import {
  PLAN_EXPIRE_STAGES,
  planExpireIdempotencyKey,
  resolveExpireStage,
} from './plan-lifecycle.rules'

describe('resolveExpireStage', () => {
  it('daysLeft=7 命中 -7（T-7）', () => {
    expect(resolveExpireStage(7)).toBe('-7')
  })

  it('daysLeft=3 命中 -3（T-3）', () => {
    expect(resolveExpireStage(3)).toBe('-3')
  })

  it('daysLeft=1 命中 -1（T-1）', () => {
    expect(resolveExpireStage(1)).toBe('-1')
  })

  it('daysLeft=0 命中 0（T+0，今天到期）', () => {
    expect(resolveExpireStage(0)).toBe('0')
  })

  it('daysLeft=-3 命中 +3（T+3，已过期 3 天）', () => {
    expect(resolveExpireStage(-3)).toBe('+3')
  })

  it('不落在五档上的 daysLeft 一律不命中', () => {
    for (const daysLeft of [30, 14, 8, 6, 5, 4, 2, -1, -2, -4, -7, -30]) {
      expect(resolveExpireStage(daysLeft), `daysLeft=${String(daysLeft)}`).toBeNull()
    }
  })

  it('daysLeft=null（未开通）永不命中', () => {
    expect(resolveExpireStage(null)).toBeNull()
  })

  it('五个档位互不重叠，穷举 -10..10 恰好只有 5 个命中', () => {
    const hits: string[] = []
    for (let d = -10; d <= 10; d += 1) {
      const stage = resolveExpireStage(d)
      if (stage) hits.push(stage)
    }
    expect(hits.sort()).toEqual([...PLAN_EXPIRE_STAGES].sort())
  })
})

describe('planExpireIdempotencyKey', () => {
  it('拼出 {tenantId}:{stage}:{yyyymmdd}', () => {
    const key = planExpireIdempotencyKey('t1', '-7', new Date('2026-03-15T01:00:00.000Z'))
    // Asia/Shanghai 比 UTC 快 8 小时：01:00 UTC = 09:00 +08:00，还是 3/15。
    expect(key).toBe('t1:-7:20260315')
  })

  it('按时区现算，UTC 午夜前后不会算错自然日', () => {
    // 2026-03-14 23:00 UTC = 2026-03-15 07:00 +08:00 —— 该是 15 号，不是 14 号。
    const key = planExpireIdempotencyKey('t1', '0', new Date('2026-03-14T23:00:00.000Z'))
    expect(key).toBe('t1:0:20260315')
  })

  it('同一天同一档位、不同租户的 key 不同（不会互相占用幂等）', () => {
    const now = new Date('2026-03-15T01:00:00.000Z')
    expect(planExpireIdempotencyKey('t1', '0', now)).not.toBe(
      planExpireIdempotencyKey('t2', '0', now),
    )
  })

  it('续费后 daysLeft 变了，同一天同一租户会算出不同的 key（不会撞上今天已经发过的档位）', () => {
    const now = new Date('2026-03-15T01:00:00.000Z')
    // 续费前算出 T-1，续费后到期日推远，daysLeft 大了很多，命中另一个档位（或不命中）。
    const before = planExpireIdempotencyKey('t1', '-1', now)
    const after = planExpireIdempotencyKey('t1', '-7', now)
    expect(before).not.toBe(after)
  })

  it('月末/跨月也按日历日正确进位', () => {
    const key = planExpireIdempotencyKey('t1', '0', new Date('2026-02-28T20:00:00.000Z'))
    // 2026-02-28 20:00 UTC = 2026-03-01 04:00 +08:00
    expect(key).toBe('t1:0:20260301')
  })
})
