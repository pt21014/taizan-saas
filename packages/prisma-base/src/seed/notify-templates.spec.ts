import { describe, expect, it } from 'vitest'

import {
  NOTIFY_TEMPLATE_KEYS,
  NOTIFY_TEMPLATE_SEEDS,
  PLAN_EXPIRE_STAGES,
  PLAN_EXPIRE_STAGE_DAYS_LEFT,
  planExpireInboxKey,
  planExpireSmsKey,
  seedNotifyTemplates,
} from './notify-templates'
import type { SeedDelegate, SeedRow, SeedUpsertArgs } from './types'

class FakeTable implements SeedDelegate {
  readonly rows = new Map<string, Record<string, unknown>>()
  readonly calls: SeedUpsertArgs[] = []

  async upsert(args: SeedUpsertArgs): Promise<SeedRow> {
    this.calls.push(args)
    const key = JSON.stringify(args.where)
    const existing = this.rows.get(key)
    if (existing === undefined) {
      const created = { ...args.create }
      this.rows.set(key, created)
      return { id: created['id'] as string }
    }
    Object.assign(existing, args.update)
    return { id: existing['id'] as string }
  }
}

function counterIds(): () => string {
  let n = 0
  return () => `id-${(n += 1)}`
}

describe('PLAN_EXPIRE_STAGES / PLAN_EXPIRE_STAGE_DAYS_LEFT', () => {
  it('五个档位与蓝图 T-7/T-3/T-1/T+0/T+3 一一对应', () => {
    expect(PLAN_EXPIRE_STAGES).toEqual(['-7', '-3', '-1', '0', '+3'])
  })

  it('daysLeft 映射方向：T-7（到期前 7 天）对应 daysLeft=7，T+3（到期后 3 天）对应 daysLeft=-3', () => {
    expect(PLAN_EXPIRE_STAGE_DAYS_LEFT['-7']).toBe(7)
    expect(PLAN_EXPIRE_STAGE_DAYS_LEFT['-3']).toBe(3)
    expect(PLAN_EXPIRE_STAGE_DAYS_LEFT['-1']).toBe(1)
    expect(PLAN_EXPIRE_STAGE_DAYS_LEFT['0']).toBe(0)
    expect(PLAN_EXPIRE_STAGE_DAYS_LEFT['+3']).toBe(-3)
  })

  it('每个档位的 daysLeft 都不相同（否则幂等键会撞档）', () => {
    const values = Object.values(PLAN_EXPIRE_STAGE_DAYS_LEFT)
    expect(new Set(values).size).toBe(values.length)
  })

  it('planExpireInboxKey / planExpireSmsKey 拼出 plan.expire.<stage>[.sms]', () => {
    expect(planExpireInboxKey('-7')).toBe('plan.expire.-7')
    expect(planExpireSmsKey('-7')).toBe('plan.expire.-7.sms')
    expect(planExpireInboxKey('+3')).toBe('plan.expire.+3')
    expect(planExpireSmsKey('0')).toBe('plan.expire.0.sms')
  })
})

describe('NOTIFY_TEMPLATE_SEEDS', () => {
  it('到期提醒 10 条（5 档 × 2 通道）+ 其它 6 条（3 语义 × 2 通道）= 16 条', () => {
    expect(NOTIFY_TEMPLATE_SEEDS).toHaveLength(16)
  })

  it('key 全局唯一', () => {
    const keys = NOTIFY_TEMPLATE_SEEDS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('每个到期档位都有 INBOX（IN_APP）与 SMS 两条', () => {
    for (const stage of PLAN_EXPIRE_STAGES) {
      const inbox = NOTIFY_TEMPLATE_SEEDS.find((s) => s.key === planExpireInboxKey(stage))
      const sms = NOTIFY_TEMPLATE_SEEDS.find((s) => s.key === planExpireSmsKey(stage))
      expect(inbox?.channel, `${stage} 的 INBOX 版`).toBe('IN_APP')
      expect(sms?.channel, `${stage} 的 SMS 版`).toBe('SMS')
    }
  })

  it('NOTIFY_TEMPLATE_KEYS 里列出的 key 都真的在 seed 数据里', () => {
    const keys = new Set(NOTIFY_TEMPLATE_SEEDS.map((s) => s.key))
    for (const key of Object.values(NOTIFY_TEMPLATE_KEYS)) {
      expect(keys.has(key), `${key} 缺一条 seed 数据`).toBe(true)
    }
  })

  it('SMS 版正文都带店铺名占位符，不比 INBOX 版长（按条计费的克制）', () => {
    for (const stage of PLAN_EXPIRE_STAGES) {
      const inbox = NOTIFY_TEMPLATE_SEEDS.find((s) => s.key === planExpireInboxKey(stage))!
      const sms = NOTIFY_TEMPLATE_SEEDS.find((s) => s.key === planExpireSmsKey(stage))!
      expect(sms.content.length).toBeLessThanOrEqual(inbox.content.length)
    }
  })
})

describe('seedNotifyTemplates', () => {
  it('幂等写入全部模板，key 定位', async () => {
    const table = new FakeTable()
    const count = await seedNotifyTemplates({ delegate: table, newId: counterIds() })
    expect(count).toBe(NOTIFY_TEMPLATE_SEEDS.length)
    expect(table.rows.size).toBe(NOTIFY_TEMPLATE_SEEDS.length)
    expect(table.calls[0]?.where).toEqual({ key: NOTIFY_TEMPLATE_SEEDS[0]?.key })
  })

  it('重跑不产生重复行，且文案跟着代码覆盖（框架初始文案，不是运营已改的产物）', async () => {
    const table = new FakeTable()
    await seedNotifyTemplates({ delegate: table, newId: counterIds() })
    const key = JSON.stringify({ key: NOTIFY_TEMPLATE_KEYS.PLAN_FULFILLED })
    ;(table.rows.get(key) as Record<string, unknown>)['title'] = '运营改过的标题'

    await seedNotifyTemplates({ delegate: table, newId: counterIds() })
    expect(table.rows.size).toBe(NOTIFY_TEMPLATE_SEEDS.length)
    expect((table.rows.get(key) as Record<string, unknown>)['title']).toBe('套餐已开通')
  })

  it('可以传自定义 specs（比如只 seed 一条，方便别的测试复用）', async () => {
    const table = new FakeTable()
    const count = await seedNotifyTemplates({
      delegate: table,
      newId: counterIds(),
      specs: [{ key: 'x.y', channel: 'SMS', title: 't', content: 'c' }],
    })
    expect(count).toBe(1)
    expect(table.rows.size).toBe(1)
  })
})
