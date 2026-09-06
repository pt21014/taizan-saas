import { Injectable } from '@nestjs/common'
import RedisMock from 'ioredis-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentContext } from '@taizan/nest-core'
import type { JobEnvelope } from '../queue/envelope'
import { JobHandler, type JobProcessor } from '../queue/job-handler.decorator'
import { MemoryQueueDriver } from '../queue/memory.driver'
import { CronRegistry } from '../cron/cron.registry'
import { CronScheduler } from '../cron/cron.scheduler'
import type { RedisClient } from '../redis/redis-client'
import { createInfraTestApp, type InfraTestApp } from '../testing/infra-test-kit'
import { OutboxRelay } from './outbox.relay'
import { OutboxService } from './outbox.service'

const delivered: { data: unknown; tenantId: string | undefined }[] = []

@Injectable()
@JobHandler({ name: 'order.paid' })
class OrderPaidHandler implements JobProcessor<{ orderId: string }> {
  async process(env: JobEnvelope<{ orderId: string }>): Promise<void> {
    delivered.push({ data: env.data, tenantId: currentContext()?.tenantId })
  }
}

describe('事务发件箱', () => {
  let app: InfraTestApp
  let driver: MemoryQueueDriver

  beforeEach(async () => {
    delivered.length = 0
    driver = new MemoryQueueDriver()
    app = await createInfraTestApp({
      redis: new RedisMock() as unknown as RedisClient,
      providers: [OrderPaidHandler],
      queue: { driver },
      queueEnabled: true,
      outbox: true,
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('enqueueInTx 在事务客户端上写 OutboxEvent（PENDING）', async () => {
    await app.get(OutboxService).enqueueInTx(app.db.prisma.raw, {
      originTenantId: 'T1',
      topic: 'order.paid',
      payload: { orderId: 'O-1' },
    })
    const rows = app.db.rows('OutboxEvent')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['status']).toBe('PENDING')
    expect(rows[0]?.['originTenantId']).toBe('T1')
    expect(rows[0]?.['attempts']).toBe(0)
  })

  it('relay 把 PENDING 推进队列并标 SENT，worker 拿到租户上下文', async () => {
    const outbox = app.get(OutboxService)
    await outbox.enqueueInTx(app.db.prisma.raw, {
      originTenantId: 'T1',
      topic: 'order.paid',
      payload: { orderId: 'O-1' },
    })
    await outbox.enqueueInTx(app.db.prisma.raw, {
      topic: 'order.paid',
      payload: { orderId: 'O-2' },
    })

    expect(await app.get(OutboxRelay).drainOnce()).toBe(2)
    await driver.drain()

    expect(app.db.rows('OutboxEvent').every((r) => r['status'] === 'SENT')).toBe(true)
    expect(delivered).toHaveLength(2)
    expect(delivered[0]).toEqual({ data: { orderId: 'O-1' }, tenantId: 'T1' })
    expect(delivered[1]).toEqual({ data: { orderId: 'O-2' }, tenantId: undefined })
  })

  it('availableAt 在未来的事件本轮不投递', async () => {
    await app.get(OutboxService).enqueueInTx(app.db.prisma.raw, {
      topic: 'order.paid',
      payload: { orderId: 'O-3' },
      availableAt: new Date(Date.now() + 60_000),
    })
    expect(await app.get(OutboxRelay).drainOnce()).toBe(0)
    expect(app.db.rows('OutboxEvent')[0]?.['status']).toBe('PENDING')
  })

  it('投递失败标 FAILED 并退避，到点后下一轮重投；重复投递靠 jobId 去重', async () => {
    // 让第一次入队炸掉，模拟队列整体挂了
    let broken = true
    const add = driver.add.bind(driver)
    driver.add = async (name, envelope, opts): Promise<string> => {
      if (broken) {
        broken = false
        throw new Error('队列连不上')
      }
      return add(name, envelope, opts)
    }

    await app.get(OutboxService).enqueueInTx(app.db.prisma.raw, {
      topic: 'order.paid',
      payload: { orderId: 'O-4' },
    })

    expect(await app.get(OutboxRelay).drainOnce()).toBe(0)
    const row = app.db.rows('OutboxEvent')[0]!
    expect(row['status']).toBe('FAILED')
    expect(row['attempts']).toBe(1)
    // 退避：availableAt 被推到未来，所以紧接着的一轮不会重投
    expect((row['availableAt'] as Date).getTime()).toBeGreaterThan(Date.now())
    expect(await app.get(OutboxRelay).drainOnce()).toBe(0)

    // 时间到了（这里直接把 availableAt 拨回去，不必真等）
    row['availableAt'] = new Date(Date.now() - 1)
    expect(await app.get(OutboxRelay).drainOnce()).toBe(1)
    expect(app.db.rows('OutboxEvent')[0]?.['status']).toBe('SENT')

    await driver.drain()
    expect(delivered).toEqual([{ data: { orderId: 'O-4' }, tenantId: undefined }])
  })

  it('OutboxRelay 自己就是一个 @LeaderCron（5 秒一轮）', () => {
    const def = app
      .get(CronRegistry)
      .discover()
      .find((d) => d.key === 'outbox-relay')
    expect(def).toBeDefined()
    expect(def?.cron).toBe('*/5 * * * * *')
    expect(def?.watchdog).toBe(true)

    const from = new Date('2026-03-01T00:00:02Z')
    expect(new Date(app.get(CronScheduler).nextFireAt(def!, from)).toISOString()).toBe(
      '2026-03-01T00:00:05.000Z',
    )
  })

  it('outbox 默认不注册（要显式 forRoot({ outbox: true })）', async () => {
    const bare = await createInfraTestApp({ redis: new RedisMock() as unknown as RedisClient })
    expect(() => bare.get(OutboxService)).toThrow()
    await bare.close()
  })
})
