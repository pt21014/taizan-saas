import { Injectable } from '@nestjs/common'
import RedisMock from 'ioredis-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentContext } from '@taizan/nest-core'
import type { RedisClient } from '../redis/redis-client'
import { createFakeInfraDb, type FakeInfraDb } from '../testing/fake-infra-db'
import { createInfraTestApp, type InfraTestApp } from '../testing/infra-test-kit'
import { CronScheduler } from './cron.scheduler'
import { CronRegistry } from './cron.registry'
import { LeaderCron } from './leader-cron.decorator'

/** 三个「实例」共用的执行计数。测试进程只有一个，所以可以直接用模块级变量数。 */
const runs: { key: string; traceId: string | undefined; parentTraceId: string | undefined }[] = []

@Injectable()
class DemoCron {
  @LeaderCron({ key: 'demo-task', cron: '*/5 * * * * *', lockTtlMs: 5000 })
  async run(): Promise<void> {
    const ctx = currentContext()
    runs.push({ key: 'demo-task', traceId: ctx?.traceId, parentTraceId: ctx?.parentTraceId })
  }
}

@Injectable()
class FailingCron {
  @LeaderCron({ key: 'failing-task', cron: '0 9 * * *', lockTtlMs: 5000 })
  async run(): Promise<void> {
    throw new Error('对账炸了')
  }
}

@Injectable()
class DuplicateKeyCron {
  @LeaderCron({ key: 'demo-task', cron: '0 9 * * *', lockTtlMs: 5000 })
  async run(): Promise<void> {}
}

describe('@LeaderCron 多实例', () => {
  let client: RedisClient
  let db: FakeInfraDb
  let apps: InfraTestApp[]

  beforeEach(async () => {
    runs.length = 0
    // 同一个 mock 客户端 = 同一台 Redis；三个 app = pm2 cluster 的三个进程
    client = new RedisMock() as unknown as RedisClient
    db = createFakeInfraDb()
    apps = await Promise.all(
      [0, 1, 2].map(() =>
        createInfraTestApp({ redis: client, db, providers: [DemoCron, FailingCron] }),
      ),
    )
  })

  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()))
  })

  // 用例 ①
  it('3 个实例同一 tick 只执行一次，CronRun 只有一条', async () => {
    const defOf = (app: InfraTestApp) => {
      const scheduler = app.get(CronScheduler)
      const def = app
        .get(CronRegistry)
        .discover()
        .find((d) => d.key === 'demo-task')
      expect(def).toBeDefined()
      return { scheduler, def: def! }
    }

    const outcomes = await Promise.all(
      apps.map(async (app) => {
        const { scheduler, def } = defOf(app)
        return scheduler.runTick(def)
      }),
    )

    expect(runs).toHaveLength(1)
    expect(outcomes.filter((o) => o.leader)).toHaveLength(1)
    expect(outcomes.filter((o) => !o.leader)).toHaveLength(2)

    const cronRuns = db.rows('CronRun').filter((r) => r['key'] === 'demo-task')
    expect(cronRuns).toHaveLength(1)
    expect(cronRuns[0]?.['ok']).toBe(true)
    expect(cronRuns[0]?.['finishedAt']).toBeInstanceOf(Date)
    // instanceId 是 hostname#pid#ulid，三个实例各不相同，能看出是哪台跑的
    expect(String(cronRuns[0]?.['instanceId'])).toMatch(/^.+#\d+#[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('每个 tick 都开新 traceId，且没有 parentTraceId（cron 没有上游）', async () => {
    const app = apps[0]!
    const scheduler = app.get(CronScheduler)
    const def = app
      .get(CronRegistry)
      .discover()
      .find((d) => d.key === 'demo-task')!

    const first = await scheduler.runTick(def)
    // 锁已释放，第二个 tick 还能抢到
    const second = await scheduler.runTick(def)

    expect(runs).toHaveLength(2)
    expect(runs[0]?.traceId).toBeTypeOf('string')
    expect(runs[0]?.traceId).not.toBe(runs[1]?.traceId)
    expect(runs[0]?.parentTraceId).toBeUndefined()
    expect(first.traceId).toBe(runs[0]?.traceId)
    expect(second.traceId).toBe(runs[1]?.traceId)
  })

  it('任务抛异常不吞：CronRun.ok=false 且 error 落库，日志有 error', async () => {
    const app = apps[0]!
    const scheduler = app.get(CronScheduler)
    const def = app
      .get(CronRegistry)
      .discover()
      .find((d) => d.key === 'failing-task')!

    const outcome = await scheduler.runTick(def)
    expect(outcome.leader).toBe(true)
    expect(outcome.ok).toBe(false)

    const row = db.rows('CronRun').find((r) => r['key'] === 'failing-task')
    expect(row?.['ok']).toBe(false)
    expect(String(row?.['error'])).toContain('对账炸了')
    expect(app.logger.matching('对账炸了').some((e) => e.level === 'error')).toBe(true)
  })

  it('锁 key 落在 lock:cron: 命名空间下', async () => {
    const app = apps[0]!
    const scheduler = app.get(CronScheduler)
    const def = app
      .get(CronRegistry)
      .discover()
      .find((d) => d.key === 'demo-task')!

    // 手动占住锁，模拟别的实例正在跑
    await client.set('taizan:lock:cron:demo-task', 'someone-else', 'PX', 5000, 'NX')
    const outcome = await scheduler.runTick(def)
    expect(outcome.leader).toBe(false)
    expect(runs).toHaveLength(0)
  })

  it('cron 表达式与时区解析正确', () => {
    const app = apps[0]!
    const scheduler = app.get(CronScheduler)
    const def = { ...app.get(CronRegistry).discover()[0]!, cron: '0 9 * * *', timezone: 'UTC' }
    const from = new Date('2026-03-01T00:00:00Z')
    expect(new Date(scheduler.nextFireAt(def, from)).toISOString()).toBe('2026-03-01T09:00:00.000Z')
  })

  it('key 重复时启动就抛（重名会让其中一个任务永远抢不到锁）', async () => {
    await expect(
      createInfraTestApp({ redis: client, db, providers: [DemoCron, DuplicateKeyCron] }),
    ).rejects.toThrow(/@LeaderCron key 重复/)
  })
})

// 用例 ⑨
describe('CRON_ENABLED', () => {
  let client: RedisClient

  beforeEach(() => {
    runs.length = 0
    client = new RedisMock() as unknown as RedisClient
  })

  it('CRON_ENABLED=false 时不调度（但仍会扫描，key 重名照样报错）', async () => {
    const app = await createInfraTestApp({
      redis: client,
      providers: [DemoCron],
      cronEnabled: false,
    })
    const scheduler = app.get(CronScheduler)
    expect(scheduler.discovered.map((d) => d.key)).toEqual(['demo-task'])
    expect(scheduler.scheduling).toBe(false)
    expect(app.logger.matching('CRON_ENABLED=false')).toHaveLength(1)

    // 给它 300ms（cron 是每 5 秒一次，这里只要证明「一个定时器都没排」）
    await new Promise((r) => setTimeout(r, 300))
    expect(runs).toHaveLength(0)
    await app.close()
  })

  it('CRON_ENABLED=true 时真的排了定时器', async () => {
    const app = await createInfraTestApp({
      redis: client,
      providers: [DemoCron],
      cronEnabled: true,
    })
    expect(app.get(CronScheduler).scheduling).toBe(true)
    await app.close()
  })
})
