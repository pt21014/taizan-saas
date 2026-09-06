import RedisMock from 'ioredis-mock'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PrismaService } from '@taizan/nest-prisma'
import { DEFAULT_KEY_PREFIX, RedisService } from '../redis/redis.service'
import type { RedisClient } from '../redis/redis-client'
import { createFakeInfraDb, type FakeInfraDb } from '../testing/fake-infra-db'
import { RecordingLogger } from '../testing/infra-test-kit'
import { IdempotencyService, idempotencyRedisKey } from './idempotency.service'

describe('IdempotencyService', () => {
  let client: RedisClient
  let db: FakeInfraDb
  let logger: RecordingLogger
  let idem: IdempotencyService

  beforeEach(() => {
    client = new RedisMock() as unknown as RedisClient
    db = createFakeInfraDb()
    logger = new RecordingLogger()
    idem = new IdempotencyService(
      new RedisService(client, DEFAULT_KEY_PREFIX),
      db.prisma as unknown as PrismaService,
      logger,
    )
  })

  // 用例 ⑦
  it('并发 10 次同 key 只执行一次，其余 fresh:false', async () => {
    let executed = 0
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        idem.run('pay.notify.wechat', 'TXN-1', async () => {
          executed += 1
          await new Promise((r) => setTimeout(r, 30))
          return { ok: true, n: executed }
        }),
      ),
    )

    expect(executed).toBe(1)
    expect(results.filter((r) => r.fresh)).toHaveLength(1)
    expect(results.filter((r) => !r.fresh)).toHaveLength(9)
    expect(results.find((r) => r.fresh)?.result).toEqual({ ok: true, n: 1 })
  })

  it('第二次调用返回 fresh:false 且带上缓存下来的结果', async () => {
    const first = await idem.run('order.create', 'K1', async () => ({ orderId: 'O-1' }))
    expect(first).toEqual({ fresh: true, result: { orderId: 'O-1' } })

    const second = await idem.run('order.create', 'K1', async () => {
      throw new Error('不该被执行')
    })
    expect(second.fresh).toBe(false)
    expect(second.result).toEqual({ orderId: 'O-1' })
  })

  it('落 IdempotencyKey 表：status=SUCCEEDED + resultHash，但不存结果本体', async () => {
    await idem.run('order.create', 'K2', async () => ({ orderId: 'O-2' }))
    const rows = db.rows('IdempotencyKey')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row['scope']).toBe('order.create')
    expect(row['key']).toBe('K2')
    expect(row['status']).toBe('SUCCEEDED')
    expect(String(row['resultHash'])).toMatch(/^[0-9a-f]{64}$/)
    expect(row['expiresAt']).toBeInstanceOf(Date)
    // 结果本体不落表（支付回调原文不该明文躺在一张谁都能查的表里）
    expect(JSON.stringify(row)).not.toContain('O-2')
  })

  it('fn 抛错时释放占位，下一次还能重试', async () => {
    await expect(
      idem.run('pay.notify.wechat', 'TXN-2', async () => {
        throw new Error('库挂了')
      }),
    ).rejects.toThrow('库挂了')

    expect(
      await client.get(`taizan:${idempotencyRedisKey('pay.notify.wechat', 'TXN-2')}`),
    ).toBeNull()

    const retry = await idem.run('pay.notify.wechat', 'TXN-2', async () => 'ok')
    expect(retry).toEqual({ fresh: true, result: 'ok' })
  })

  it('Redis 缓存过期后仍能从表里回答「处理过没有」，但拿不到结果本体', async () => {
    await idem.run('order.create', 'K3', async () => ({ orderId: 'O-3' }), 1)
    // 直接把 Redis 那份删掉，模拟过期 / flush
    await client.del(`taizan:${idempotencyRedisKey('order.create', 'K3')}`)

    expect(await idem.seen('order.create', 'K3')).toBe(true)
    expect(await idem.seen('order.create', 'NEVER')).toBe(false)
  })

  it('写表失败不抛（fn 已经跑完了，抛出去只会让调用方重试一遍），但打 error', async () => {
    db.failNext('IdempotencyKey', 'upsert')
    const outcome = await idem.run('order.create', 'K4', async () => 'done')
    expect(outcome).toEqual({ fresh: true, result: 'done' })
    expect(logger.matching('写 IdempotencyKey 失败').some((e) => e.level === 'error')).toBe(true)
  })
})
