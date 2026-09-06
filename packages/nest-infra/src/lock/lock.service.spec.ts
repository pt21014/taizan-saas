import RedisMock from 'ioredis-mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedisService, DEFAULT_KEY_PREFIX } from '../redis/redis.service'
import type { RedisClient } from '../redis/redis-client'
import { LockService, normalizeLockKey } from './lock.service'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('LockService', () => {
  let client: RedisClient
  let redis: RedisService
  /** 两个「进程」，共用同一台 Redis。 */
  let a: LockService
  let b: LockService

  beforeEach(() => {
    client = new RedisMock() as unknown as RedisClient
    redis = new RedisService(client, DEFAULT_KEY_PREFIX)
    a = new LockService(redis, 'host-a#1#AAA')
    b = new LockService(redis, 'host-b#2#BBB')
  })

  it('key 强制 lock: 前缀，且不会重复加', () => {
    expect(normalizeLockKey('cron:x')).toBe('lock:cron:x')
    expect(normalizeLockKey('lock:cron:x')).toBe('lock:cron:x')
    expect(() => normalizeLockKey('   ')).toThrow(/不能为空/)
  })

  it('同一把锁只有一个持有者，另一个立刻拿到 null（不抛、不排队）', async () => {
    let inside = 0
    const [ra, rb] = await Promise.all([
      a.withLock('demo', 2000, async () => {
        inside += 1
        await sleep(120)
        return 'A'
      }),
      sleep(20).then(() =>
        b.withLock('demo', 2000, async () => {
          inside += 1
          return 'B'
        }),
      ),
    ])
    expect(inside).toBe(1)
    expect([ra, rb].filter((r) => r !== null)).toEqual(['A'])
  })

  it('fn 抛错时先释放锁再重抛，锁不会卡满一个 TTL', async () => {
    await expect(
      a.withLock('boom', 60_000, async () => {
        throw new Error('业务炸了')
      }),
    ).rejects.toThrow('业务炸了')

    // 锁已经释放：另一个「进程」马上就能拿到
    const got = await b.withLock('boom', 1000, async () => 'ok')
    expect(got).toBe('ok')
  })

  // 用例 ②
  it('持有者「崩溃」（不释放）后，TTL 到期他人可以获取', async () => {
    // 直接 acquire 不 release，模拟进程被 kill：没人跑 finally
    const held = await a.acquire('crashy', 200)
    expect(held).not.toBeNull()

    // TTL 内别人拿不到
    expect(await b.acquire('crashy', 200)).toBeNull()

    await sleep(280)

    // TTL 过了，接管成功
    const taken = await b.acquire('crashy', 500)
    expect(taken).not.toBeNull()

    // 而「崩溃」的那个实例即使事后来释放，也删不掉别人的锁（Lua 比对 token）
    expect(held ? await a.release(held) : true).toBe(false)
    expect(await redis.get('lock:crashy')).not.toBeNull()
  })

  // 用例 ③
  //
  // 之前这条用例靠真实定时器 + 紧凑 TTL（240ms）卡时序：单跑没问题，
  // 但 `pnpm test` 根并发跑 33 个任务、机器满载时，事件循环调度延迟会让
  // "sleep(ttl*2)" 实际多花几十毫秒，足够吃掉 watchdog 续期或 TTL 到期之间
  // 本就不宽裕的余量，导致偶发失败。
  //
  // 修法：改用 `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` 精确推进虚拟时钟。
  // 验证过 ioredis-mock 的 PX/PEXPIRE 过期判断走的是 `Date.now()`（懒惰过期，
  // 见 ioredis-mock `src/expires.js` 的 `isExpired`），而 vitest 的 fake timers
  // 默认会一并接管 `Date`，所以虚拟时钟推进时锁的过期判断、`setInterval` 续期
  // 都会精确跟随，不再依赖真实时间流逝——时序断言与真实时钟下完全一致，
  // 只是不再受机器负载影响。
  it('watchdog 续期让长任务不丢锁；不开 watchdog 的同样任务会丢', async () => {
    vi.useFakeTimers()
    try {
      const ttl = 240
      // 任务耗时 3 倍 TTL，watchdog 每 ttl/3 = 80ms 续一次
      const withDog = a.withLock(
        'slow',
        ttl,
        async () => {
          await sleep(ttl * 3)
          return 'done'
        },
        { watchdog: true },
      )

      // 任务跑到 2 倍 TTL 时，锁还在，别人抢不到
      await vi.advanceTimersByTimeAsync(ttl * 2)
      expect(await b.acquire('slow', 100)).toBeNull()

      // 推进剩余时间，任务完成
      await vi.advanceTimersByTimeAsync(ttl)
      expect(await withDog).toBe('done')

      // 对照组：同样的任务不开 watchdog，锁会在中途过期被别人抢走
      const withoutDog = a.withLock('slow2', ttl, async () => {
        await sleep(ttl * 3)
        return 'done'
      })
      await vi.advanceTimersByTimeAsync(ttl * 2)
      expect(await b.acquire('slow2', 1000)).not.toBeNull()
      await vi.advanceTimersByTimeAsync(ttl)
      await withoutDog
    } finally {
      vi.useRealTimers()
    }
  })

  it('waitMs 内等到锁就返回结果，等不到返回 null', async () => {
    const holder = a.withLock('waity', 2000, async () => {
      await sleep(150)
      return 'A'
    })
    await sleep(20)

    // 等 800ms 足够等到 A 释放
    const patient = await b.withLock('waity', 2000, async () => 'B', { waitMs: 800 })
    expect(patient).toBe('B')
    expect(await holder).toBe('A')

    // 再来一次，这次只等 30ms，等不到
    const holder2 = a.withLock('waity', 2000, async () => {
      await sleep(200)
      return 'A2'
    })
    await sleep(20)
    expect(await b.withLock('waity', 2000, async () => 'B2', { waitMs: 30 })).toBeNull()
    await holder2
  })

  it('TTL 非法直接抛（而不是悄悄用一个默认值）', async () => {
    await expect(a.withLock('x', 0, async () => 1)).rejects.toThrow(/TTL 必须是正数/)
  })
})
