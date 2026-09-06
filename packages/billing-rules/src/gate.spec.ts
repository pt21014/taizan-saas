import { describe, expect, it } from 'vitest'

import { ErrorCode, httpSemantic } from '@taizan/contracts'

import {
  evaluateTenantGate,
  gateToErrorCode,
  type GatePhase,
  type TenantGateInput,
  type TenantStatusLike,
} from './gate'

/** 东八区墙上时间 → Date。全部用例都写成人看得懂的「北京时间」，避免自己在脑子里加 8 小时。 */
function sh(wall: string): Date {
  return new Date(`${wall.replace(' ', 'T')}+08:00`)
}

/** 纽约墙上时间 → Date（夏令时期间 -04:00）。 */
function nyDst(wall: string): Date {
  return new Date(`${wall.replace(' ', 'T')}-04:00`)
}

const EXPIRE = sh('2026-03-10 23:59:59.999')

function gate(over: Partial<TenantGateInput> = {}) {
  return evaluateTenantGate({
    now: sh('2026-03-01 10:00:00'),
    status: 'ACTIVE',
    planExpireAt: EXPIRE,
    graceDays: 0,
    enforcing: true,
    ...over,
  })
}

describe('evaluateTenantGate / 阶段判定 × enforcing 两态', () => {
  it('ACTIVE 未到期：可写、开门、无 reason', () => {
    const r = gate()
    expect(r).toMatchObject({
      adminWritable: true,
      clientOpen: true,
      reason: null,
      phase: 'ACTIVE',
    })
  })

  it('ACTIVE 未到期 + enforcing=false：结论不变', () => {
    expect(gate({ enforcing: false })).toMatchObject({
      adminWritable: true,
      clientOpen: true,
      reason: null,
      phase: 'ACTIVE',
    })
  })

  it('TRIAL 未到期：phase 是 TRIAL 而不是 ACTIVE', () => {
    const r = gate({ status: 'TRIAL', trialEndAt: EXPIRE, planExpireAt: null })
    expect(r.phase).toBe('TRIAL')
    expect(r.adminWritable).toBe(true)
  })

  it('TRIAL + enforcing=false：phase 仍是 TRIAL', () => {
    const r = gate({ status: 'TRIAL', trialEndAt: EXPIRE, planExpireAt: null, enforcing: false })
    expect(r.phase).toBe('TRIAL')
  })

  it('TRIAL 时 trialEndAt 优先于 planExpireAt', () => {
    const r = gate({
      status: 'TRIAL',
      trialEndAt: sh('2026-03-02 23:59:59.999'),
      planExpireAt: sh('2026-12-31 23:59:59.999'),
      now: sh('2026-03-05 00:00:00'),
    })
    expect(r.phase).toBe('EXPIRED')
  })

  it('TRIAL 但 trialEndAt 缺省时回落到 planExpireAt', () => {
    const r = gate({ status: 'TRIAL', planExpireAt: EXPIRE })
    expect(r.phase).toBe('TRIAL')
    expect(r.daysLeft).toBe(9)
  })

  it('TRIAL 且 trialEndAt 显式传 null 时也回落到 planExpireAt', () => {
    const r = gate({ status: 'TRIAL', trialEndAt: null, planExpireAt: EXPIRE })
    expect(r.phase).toBe('TRIAL')
  })

  it('非 TRIAL 状态忽略 trialEndAt', () => {
    const r = gate({
      status: 'ACTIVE',
      trialEndAt: sh('2020-01-01 23:59:59.999'),
      planExpireAt: EXPIRE,
    })
    expect(r.phase).toBe('ACTIVE')
  })

  it('GRACE：后台仍可写、C 端仍开门，但 reason 给出 GRACE', () => {
    const r = gate({ graceDays: 3, now: sh('2026-03-11 09:00:00') })
    expect(r).toMatchObject({
      adminWritable: true,
      clientOpen: true,
      reason: 'GRACE',
      phase: 'GRACE',
    })
  })

  it('GRACE + enforcing=false：reason 照常是 GRACE', () => {
    const r = gate({ graceDays: 3, now: sh('2026-03-11 09:00:00'), enforcing: false })
    expect(r.reason).toBe('GRACE')
    expect(r.phase).toBe('GRACE')
  })

  it('EXPIRED：后台只读、C 端打烊', () => {
    const r = gate({ now: sh('2026-03-11 00:00:00') })
    expect(r).toMatchObject({
      adminWritable: false,
      clientOpen: false,
      reason: 'EXPIRED',
      phase: 'EXPIRED',
    })
  })

  it('EXPIRED + enforcing=false：放行但 reason/phase 照常给', () => {
    const r = gate({ now: sh('2026-03-11 00:00:00'), enforcing: false })
    expect(r).toMatchObject({
      adminWritable: true,
      clientOpen: true,
      reason: 'EXPIRED',
      phase: 'EXPIRED',
    })
  })

  it('EXPIRED + enforcing=false 时 daysLeft 照常是负数', () => {
    expect(gate({ now: sh('2026-03-14 08:00:00'), enforcing: false }).daysLeft).toBe(-4)
  })

  it('SUSPENDED：不可写、不开门', () => {
    expect(gate({ status: 'SUSPENDED' })).toMatchObject({
      adminWritable: false,
      clientOpen: false,
      reason: 'SUSPENDED',
      phase: 'SUSPENDED',
    })
  })

  it('SUSPENDED 与 enforcing 无关：enforcing=false 也照锁不误', () => {
    expect(gate({ status: 'SUSPENDED', enforcing: false })).toMatchObject({
      adminWritable: false,
      clientOpen: false,
      reason: 'SUSPENDED',
    })
  })

  it('SUSPENDED 即使套餐远未到期也不可写', () => {
    const r = gate({ status: 'SUSPENDED', planExpireAt: sh('2099-12-31 23:59:59.999') })
    expect(r.adminWritable).toBe(false)
  })

  it('DEREGISTERED：不可写、不开门', () => {
    expect(gate({ status: 'DEREGISTERED' })).toMatchObject({
      adminWritable: false,
      clientOpen: false,
      reason: 'DEREGISTERED',
      phase: 'DEREGISTERED',
    })
  })

  it('DEREGISTERED 与 enforcing 无关', () => {
    expect(gate({ status: 'DEREGISTERED', enforcing: false }).adminWritable).toBe(false)
  })

  it('DEREGISTERED 即使套餐远未到期也不开门', () => {
    const r = gate({ status: 'DEREGISTERED', planExpireAt: sh('2099-12-31 23:59:59.999') })
    expect(r.clientOpen).toBe(false)
  })

  it('硬闸门仍然把 daysLeft 算出来（平台后台要显示套餐还剩几天）', () => {
    expect(gate({ status: 'SUSPENDED' }).daysLeft).toBe(9)
  })

  it('PENDING：没有任何到期日可算', () => {
    expect(gate({ planExpireAt: null })).toMatchObject({
      adminWritable: false,
      clientOpen: false,
      reason: 'PENDING',
      phase: 'PENDING',
      daysLeft: null,
    })
  })

  it('PENDING 受 enforcing 管：关掉时放行，但 reason 仍是 PENDING', () => {
    expect(gate({ planExpireAt: null, enforcing: false })).toMatchObject({
      adminWritable: true,
      clientOpen: true,
      reason: 'PENDING',
      phase: 'PENDING',
    })
  })

  it('TRIAL 且两个日期都为空 → PENDING', () => {
    expect(gate({ status: 'TRIAL', trialEndAt: null, planExpireAt: null }).phase).toBe('PENDING')
  })

  it('SUSPENDED 且无到期日：phase 是 SUSPENDED（硬闸门优先于 PENDING）', () => {
    const r = gate({ status: 'SUSPENDED', planExpireAt: null })
    expect(r.phase).toBe('SUSPENDED')
    expect(r.daysLeft).toBeNull()
  })

  it('结果原样回传 enforcing，便于日志里区分「算了但没拦」', () => {
    expect(gate({ enforcing: false }).enforcing).toBe(false)
    expect(gate({ enforcing: true }).enforcing).toBe(true)
  })
})

describe('evaluateTenantGate / 到期边界时刻（graceDays=0）', () => {
  it('到期前 1 秒：未到期', () => {
    expect(gate({ now: sh('2026-03-10 23:59:58.999') }).phase).toBe('ACTIVE')
  })

  it('到期当天 23:59:59：未到期（这是蓝图写死的那一刻）', () => {
    const r = gate({ now: sh('2026-03-10 23:59:59') })
    expect(r.phase).toBe('ACTIVE')
    expect(r.adminWritable).toBe(true)
  })

  it('到期当天 23:59:59.999：仍未到期（当天最后一毫秒）', () => {
    expect(gate({ now: sh('2026-03-10 23:59:59.999') }).phase).toBe('ACTIVE')
  })

  it('次日 00:00:00.000：到期', () => {
    expect(gate({ now: sh('2026-03-11 00:00:00.000') }).phase).toBe('EXPIRED')
  })

  it('次日 00:00:00.001：到期', () => {
    expect(gate({ now: sh('2026-03-11 00:00:00.001') }).phase).toBe('EXPIRED')
  })

  it('到期当天 00:00:00：未到期', () => {
    expect(gate({ now: sh('2026-03-10 00:00:00') }).phase).toBe('ACTIVE')
  })

  it('planExpireAt 落在当天上午 10 点时，当天 23:59:59 仍算未到期', () => {
    const r = gate({
      planExpireAt: sh('2026-03-10 10:00:00'),
      now: sh('2026-03-10 23:59:59'),
    })
    expect(r.phase).toBe('ACTIVE')
  })

  it('planExpireAt 落在当天 00:00:00 时，当天 23:59:59 仍算未到期', () => {
    const r = gate({
      planExpireAt: sh('2026-03-10 00:00:00'),
      now: sh('2026-03-10 23:59:59'),
    })
    expect(r.phase).toBe('ACTIVE')
  })

  it('planExpireAt 落在当天上午 10 点时，次日 00:00:00 到期', () => {
    const r = gate({ planExpireAt: sh('2026-03-10 10:00:00'), now: sh('2026-03-11 00:00:00') })
    expect(r.phase).toBe('EXPIRED')
  })

  it('graceDays=0 时不存在 GRACE 阶段', () => {
    expect(gate({ now: sh('2026-03-11 00:00:00'), graceDays: 0 }).reason).toBe('EXPIRED')
  })
})

describe('evaluateTenantGate / 宽限期边界', () => {
  it('graceDays=3：到期次日 00:00:00 进入 GRACE', () => {
    expect(gate({ graceDays: 3, now: sh('2026-03-11 00:00:00') }).phase).toBe('GRACE')
  })

  it('graceDays=3：宽限最后一天 23:59:59 仍是 GRACE', () => {
    expect(gate({ graceDays: 3, now: sh('2026-03-13 23:59:59') }).phase).toBe('GRACE')
  })

  it('graceDays=3：宽限最后一天 23:59:59.999 仍是 GRACE', () => {
    expect(gate({ graceDays: 3, now: sh('2026-03-13 23:59:59.999') }).phase).toBe('GRACE')
  })

  it('graceDays=3：宽限结束次日 00:00:00 转 EXPIRED', () => {
    expect(gate({ graceDays: 3, now: sh('2026-03-14 00:00:00') }).phase).toBe('EXPIRED')
  })

  it('graceDays=1：到期次日 23:59:59 是 GRACE', () => {
    expect(gate({ graceDays: 1, now: sh('2026-03-11 23:59:59') }).phase).toBe('GRACE')
  })

  it('graceDays=1：第三天 00:00:00 是 EXPIRED', () => {
    expect(gate({ graceDays: 1, now: sh('2026-03-12 00:00:00') }).phase).toBe('EXPIRED')
  })

  it('宽限期内 C 端不打烊（别在半夜把正在做生意的店锁了）', () => {
    expect(gate({ graceDays: 7, now: sh('2026-03-15 20:00:00') }).clientOpen).toBe(true)
  })

  it('过了宽限期 C 端打烊', () => {
    expect(gate({ graceDays: 7, now: sh('2026-03-18 00:00:00') }).clientOpen).toBe(false)
  })

  it('宽限期跨月：3/31 到期 + 3 天 → 4/3 仍是 GRACE', () => {
    const r = gate({
      planExpireAt: sh('2026-03-31 23:59:59.999'),
      graceDays: 3,
      now: sh('2026-04-03 12:00:00'),
    })
    expect(r.phase).toBe('GRACE')
  })

  it('宽限期跨月：3/31 到期 + 3 天 → 4/4 转 EXPIRED', () => {
    const r = gate({
      planExpireAt: sh('2026-03-31 23:59:59.999'),
      graceDays: 3,
      now: sh('2026-04-04 00:00:00'),
    })
    expect(r.phase).toBe('EXPIRED')
  })

  it('宽限期跨年：12/31 到期 + 2 天 → 次年 1/2 仍是 GRACE', () => {
    const r = gate({
      planExpireAt: sh('2026-12-31 23:59:59.999'),
      graceDays: 2,
      now: sh('2027-01-02 23:00:00'),
    })
    expect(r.phase).toBe('GRACE')
  })

  it('TRIAL 到期后同样走宽限期', () => {
    const r = gate({
      status: 'TRIAL',
      trialEndAt: sh('2026-03-10 23:59:59.999'),
      planExpireAt: null,
      graceDays: 2,
      now: sh('2026-03-12 10:00:00'),
    })
    expect(r.phase).toBe('GRACE')
  })
})

describe('evaluateTenantGate / daysLeft 按日历日算', () => {
  it('到期当天返回 0', () => {
    expect(gate({ now: sh('2026-03-10 00:00:01') }).daysLeft).toBe(0)
  })

  it('到期前一天返回 1', () => {
    expect(gate({ now: sh('2026-03-09 00:00:00') }).daysLeft).toBe(1)
  })

  it('到期前 7 天返回 7（催费 cron 的 T-7 档）', () => {
    expect(gate({ now: sh('2026-03-03 18:00:00') }).daysLeft).toBe(7)
  })

  it('到期次日返回 -1', () => {
    expect(gate({ now: sh('2026-03-11 08:00:00') }).daysLeft).toBe(-1)
  })

  it('到期后第 3 天返回 -3（催费 cron 的 T+3 档）', () => {
    expect(gate({ now: sh('2026-03-13 08:00:00') }).daysLeft).toBe(-3)
  })

  it('按日历日而非 24 小时：23:00 到次日 01:00 算 1 天', () => {
    const r = gate({ now: sh('2026-03-09 23:00:00'), planExpireAt: sh('2026-03-10 01:00:00') })
    expect(r.daysLeft).toBe(1)
  })

  it('同一天内的任何时刻都是 0 天', () => {
    expect(gate({ now: sh('2026-03-10 00:00:00') }).daysLeft).toBe(0)
    expect(gate({ now: sh('2026-03-10 23:59:59') }).daysLeft).toBe(0)
  })

  it('TRIAL 用 trialEndAt 算 daysLeft', () => {
    const r = gate({
      status: 'TRIAL',
      trialEndAt: sh('2026-03-05 23:59:59.999'),
      planExpireAt: sh('2026-12-31 23:59:59.999'),
    })
    expect(r.daysLeft).toBe(4)
  })

  it('PENDING 时 daysLeft 为 null', () => {
    expect(gate({ planExpireAt: null }).daysLeft).toBeNull()
  })
})

describe('evaluateTenantGate / 时区参数化（绝不依赖进程时区）', () => {
  it('同一瞬间：北京已过 3/11，纽约仍是 3/10', () => {
    const now = sh('2026-03-11 09:00:00') // = 纽约 3/10 21:00（EDT）
    expect(gate({ now }).phase).toBe('EXPIRED')
    expect(
      gate({
        now,
        planExpireAt: nyDst('2026-03-10 23:59:59.999'),
        timezone: 'America/New_York',
      }).phase,
    ).toBe('ACTIVE')
  })

  it('timezone=UTC 时按 UTC 的当天末判定', () => {
    const r = evaluateTenantGate({
      now: new Date('2026-03-10T23:59:59.000Z'),
      status: 'ACTIVE',
      planExpireAt: new Date('2026-03-10T00:00:00.000Z'),
      graceDays: 0,
      enforcing: true,
      timezone: 'UTC',
    })
    expect(r.phase).toBe('ACTIVE')
  })

  it('timezone=UTC 时次日 00:00:00Z 到期', () => {
    const r = evaluateTenantGate({
      now: new Date('2026-03-11T00:00:00.000Z'),
      status: 'ACTIVE',
      planExpireAt: new Date('2026-03-10T00:00:00.000Z'),
      graceDays: 0,
      enforcing: true,
      timezone: 'UTC',
    })
    expect(r.phase).toBe('EXPIRED')
  })

  it('Asia/Tokyo（+9）比 Asia/Shanghai 早一小时翻页', () => {
    const now = new Date('2026-03-10T15:30:00.000Z') // 东京 3/11 00:30，北京 3/10 23:30
    const planExpireAt = new Date('2026-03-10T02:00:00.000Z')
    expect(gate({ now, planExpireAt, timezone: 'Asia/Shanghai' }).phase).toBe('ACTIVE')
    expect(gate({ now, planExpireAt, timezone: 'Asia/Tokyo' }).phase).toBe('EXPIRED')
  })

  it('daysLeft 也随时区变化', () => {
    const now = new Date('2026-03-10T15:30:00.000Z')
    const planExpireAt = new Date('2026-03-12T02:00:00.000Z')
    expect(gate({ now, planExpireAt, timezone: 'Asia/Shanghai' }).daysLeft).toBe(2)
    expect(gate({ now, planExpireAt, timezone: 'Asia/Tokyo' }).daysLeft).toBe(1)
  })

  it('跨夏令时的时区（America/New_York）也能算出当天末', () => {
    const r = gate({
      now: nyDst('2026-07-04 23:59:59'),
      planExpireAt: nyDst('2026-07-04 08:00:00'),
      timezone: 'America/New_York',
    })
    expect(r.phase).toBe('ACTIVE')
  })

  it('无法识别的时区抛 RangeError 且报错是中文', () => {
    expect(() => gate({ timezone: 'Mars/Olympus' })).toThrow(RangeError)
    expect(() => gate({ timezone: 'Mars/Olympus' })).toThrow(/无法识别的时区/)
  })
})

describe('evaluateTenantGate / 入参校验', () => {
  it('now 不是合法 Date 时抛 TypeError', () => {
    expect(() => gate({ now: new Date('nope') })).toThrow(TypeError)
  })

  it('planExpireAt 是 Invalid Date 时抛', () => {
    expect(() => gate({ planExpireAt: new Date('nope') })).toThrow(/planExpireAt/)
  })

  it('trialEndAt 是 Invalid Date 时抛', () => {
    expect(() => gate({ status: 'TRIAL', trialEndAt: new Date('nope') })).toThrow(/trialEndAt/)
  })

  it('graceDays 是负数时抛 RangeError', () => {
    expect(() => gate({ graceDays: -1 })).toThrow(RangeError)
  })

  it('graceDays 是小数时抛 RangeError', () => {
    expect(() => gate({ graceDays: 1.5 })).toThrow(/graceDays/)
  })

  it('graceDays 是 NaN 时抛', () => {
    expect(() => gate({ graceDays: Number.NaN })).toThrow(RangeError)
  })
})

describe('evaluateTenantGate / 阶段 × enforcing 全矩阵', () => {
  const cases: Array<{ phase: GatePhase; over: Partial<TenantGateInput> }> = [
    { phase: 'ACTIVE', over: {} },
    { phase: 'TRIAL', over: { status: 'TRIAL', trialEndAt: EXPIRE } },
    { phase: 'GRACE', over: { graceDays: 3, now: sh('2026-03-12 00:00:00') } },
    { phase: 'EXPIRED', over: { now: sh('2026-03-12 00:00:00') } },
    { phase: 'SUSPENDED', over: { status: 'SUSPENDED' } },
    { phase: 'DEREGISTERED', over: { status: 'DEREGISTERED' } },
    { phase: 'PENDING', over: { planExpireAt: null } },
  ]

  for (const c of cases) {
    it(`${c.phase} / enforcing=true 时 phase 正确`, () => {
      expect(gate({ ...c.over, enforcing: true }).phase).toBe(c.phase)
    })
    it(`${c.phase} / enforcing=false 时 phase 不变`, () => {
      expect(gate({ ...c.over, enforcing: false }).phase).toBe(c.phase)
    })
    it(`${c.phase} / enforcing 两态下 reason 一致`, () => {
      expect(gate({ ...c.over, enforcing: false }).reason).toBe(
        gate({ ...c.over, enforcing: true }).reason,
      )
    })
    it(`${c.phase} / enforcing 两态下 daysLeft 一致`, () => {
      expect(gate({ ...c.over, enforcing: false }).daysLeft).toBe(
        gate({ ...c.over, enforcing: true }).daysLeft,
      )
    })
  }

  const hardStatuses: TenantStatusLike[] = ['SUSPENDED', 'DEREGISTERED']
  for (const status of hardStatuses) {
    it(`${status} 在 enforcing=false 下依然不可写不开门`, () => {
      const r = gate({ status, enforcing: false })
      expect(r.adminWritable).toBe(false)
      expect(r.clientOpen).toBe(false)
    })
  }
})

describe('gateToErrorCode', () => {
  it('后台被拦 → 1440301', () => {
    expect(gateToErrorCode(gate({ now: sh('2026-03-12 00:00:00') }), 'admin')).toBe(1440301)
  })

  it('后台放行 → null', () => {
    expect(gateToErrorCode(gate(), 'admin')).toBeNull()
  })

  it('C 端被拦 → 1440302', () => {
    expect(gateToErrorCode(gate({ now: sh('2026-03-12 00:00:00') }), 'client')).toBe(1440302)
  })

  it('C 端放行 → null', () => {
    expect(gateToErrorCode(gate(), 'client')).toBeNull()
  })

  it('码值取自 @taizan/contracts，不在本包硬编码', () => {
    expect(ErrorCode.PLAN_READONLY.code).toBe(1440301)
    expect(ErrorCode.SHOP_CLOSED.code).toBe(1440302)
  })

  it('两个码的 HTTP 语义都是 403（前端只提示、不登出）', () => {
    expect(httpSemantic(ErrorCode.PLAN_READONLY.code)).toBe(403)
    expect(httpSemantic(ErrorCode.SHOP_CLOSED.code)).toBe(403)
  })

  it('宽限期内不给错误码（只挂横幅，不拦人）', () => {
    const r = gate({ graceDays: 3, now: sh('2026-03-11 10:00:00') })
    expect(gateToErrorCode(r, 'admin')).toBeNull()
    expect(gateToErrorCode(r, 'client')).toBeNull()
  })

  it('enforcing=false 时不给错误码（想知道谁会被锁要读 phase/reason）', () => {
    const r = gate({ now: sh('2026-03-12 00:00:00'), enforcing: false })
    expect(gateToErrorCode(r, 'admin')).toBeNull()
    expect(r.phase).toBe('EXPIRED')
  })

  it('SUSPENDED + enforcing=false 仍然给错误码（硬闸门掀不动）', () => {
    const r = gate({ status: 'SUSPENDED', enforcing: false })
    expect(gateToErrorCode(r, 'admin')).toBe(1440301)
    expect(gateToErrorCode(r, 'client')).toBe(1440302)
  })

  it('PENDING + enforcing=true 时后台给 1440301', () => {
    expect(gateToErrorCode(gate({ planExpireAt: null }), 'admin')).toBe(1440301)
  })

  it('计费码与配额/功能码是四个不同的值（三道闸门并列不合并）', () => {
    const codes = new Set([
      ErrorCode.PLAN_READONLY.code,
      ErrorCode.SHOP_CLOSED.code,
      ErrorCode.QUOTA_EXCEEDED.code,
      ErrorCode.FEATURE_NOT_INCLUDED.code,
    ])
    expect(codes.size).toBe(4)
  })
})
