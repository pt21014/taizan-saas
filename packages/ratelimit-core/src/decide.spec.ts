/**
 * 三维度判定与降级。
 *
 * 最要紧的一条在最后：**store 抛错时必须仍然拦得住**。
 * 「Redis 挂了就放行」是一行 catch 的事，而它的后果是抖动那几分钟里限流完全消失，
 * 且不会有任何东西报错——所以它在这里有独立的一组用例。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineTier, type RateLimitTier } from './config'
import { decide, resetProcessLocalCounters, UnknownTierError } from './decide'
import { buildKey, MemoryRateLimitStore, RedisRateLimitStore, type RateLimitStore } from './store'

const TIER: RateLimitTier = defineTier({
  name: 'unit',
  windowSec: 60,
  clientLimit: 3,
  edgeLimit: 20,
  accountLimit: 30,
  counts: 'failures',
  note: '单测用',
})

const CLIENT = '222.137.6.155'
const EDGE = '114.66.247.140'

/** 每次都抛的 store，模拟 Redis 挂掉。 */
const brokenStore = (): RateLimitStore => ({
  incr: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:6379')),
})

/** 只实现 incr、不实现 ttlSec 的 store（接口的最小实现）。 */
const minimalStore = (): RateLimitStore => {
  const counts = new Map<string, number>()
  return {
    async incr(key) {
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return n
    },
  }
}

let store: MemoryRateLimitStore

beforeEach(() => {
  store = new MemoryRateLimitStore()
  resetProcessLocalCounters()
})

const hit = (keys: { client?: string; edge?: string; account?: string } = {}) =>
  decide({
    tier: TIER,
    store,
    keys: { client: keys.client ?? CLIENT, edge: keys.edge ?? EDGE, account: keys.account },
  })

describe('decide 基本判定', () => {
  it('额度内放行，counts 逐次递增', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const d = await hit()
      expect(d.allowed).toBe(true)
      expect(d.counts.client).toBe(i)
    }
  })

  it('limit 的含义是「放过 N 次，第 N+1 次拒绝」', async () => {
    await hit()
    await hit()
    await hit()
    const d = await hit()
    expect(d.allowed).toBe(false)
    expect(d.hitDimension).toBe('client')
  })

  it('拒绝时给 retryAfterSec 与已渲染的文案', async () => {
    for (let i = 0; i < 4; i += 1) await hit()
    const d = await hit()
    expect(d.retryAfterSec).toBeGreaterThan(0)
    expect(d.retryAfterSec).toBeLessThanOrEqual(TIER.windowSec)
    expect(d.message).toMatch(/秒后再试/)
    expect(d.message).not.toContain('{sec}')
  })

  it('store 不实现 ttlSec 时 retryAfterSec 退回整个窗口长度（宁可让他多等）', async () => {
    const s = minimalStore()
    for (let i = 0; i < 4; i += 1)
      await decide({ tier: TIER, store: s, keys: { client: CLIENT, edge: EDGE } })
    const d = await decide({ tier: TIER, store: s, keys: { client: CLIENT, edge: EDGE } })
    expect(d.retryAfterSec).toBe(TIER.windowSec)
  })

  it('不同客户端 IP 互不影响', async () => {
    for (let i = 0; i < 5; i += 1) await hit({ client: '1.2.3.4' })
    expect((await hit({ client: '5.6.7.8' })).allowed).toBe(true)
  })

  it('窗口过去之后额度恢复', async () => {
    let now = 1_000_000
    const clocked = new MemoryRateLimitStore(() => now)
    const run = () => decide({ tier: TIER, store: clocked, keys: { client: CLIENT, edge: EDGE } })
    for (let i = 0; i < 4; i += 1) await run()
    expect((await run()).allowed).toBe(false)
    now += TIER.windowSec * 1000 + 1
    expect((await run()).allowed).toBe(true)
  })

  it('拼错的档位名抛错，而不是「不认识就放行」', async () => {
    await expect(
      decide({ tier: 'lgoin', store, keys: { client: CLIENT, edge: EDGE } }),
    ).rejects.toThrow(UnknownTierError)
  })

  it('用内置档位名也能调（守卫读到的就是字符串）', async () => {
    const d = await decide({ tier: 'login', store, keys: { client: CLIENT, edge: EDGE } })
    expect(d.tier).toBe('login')
    expect(d.allowed).toBe(true)
  })
})

describe('decide 三维度各自命中', () => {
  it('客户端维度：同一个 IP 打满', async () => {
    for (let i = 0; i < 4; i += 1) await hit()
    expect((await hit()).hitDimension).toBe('client')
  })

  it('入口维度：轮换伪造前缀导致客户端维度永远打不满时，由不可伪造的入口兜住', async () => {
    // 攻击者每次换一个 client（在真实链路里就是他改不了的那段，这里直接模拟
    // 「万一 hops 配错、client 真的被换掉了」的最坏情况）
    for (let i = 0; i < 20; i += 1) {
      const d = await hit({ client: `10.0.0.${i}` })
      expect(d.allowed).toBe(true)
    }
    const d = await hit({ client: '10.0.0.99' })
    expect(d.allowed).toBe(false)
    expect(d.hitDimension).toBe('edge')
  })

  it('账号维度：换 IP 爆破同一个账号会被兜住，别的账号不受牵连', async () => {
    for (let i = 0; i < 30; i += 1) {
      await hit({ client: `10.1.0.${i}`, edge: `10.9.0.${i}`, account: 'owner@shop' })
    }
    const blocked = await hit({ client: '10.1.9.9', edge: '10.9.9.9', account: 'owner@shop' })
    expect(blocked.allowed).toBe(false)
    expect(blocked.hitDimension).toBe('account')

    const other = await hit({ client: '10.1.9.9', edge: '10.9.9.8', account: 'someone-else' })
    expect(other.allowed).toBe(true)
  })

  it('账号大小写不同视为同一个账号（否则额度直接翻倍）', async () => {
    expect(buildKey('t', 'account', 'Admin')).toBe(buildKey('t', 'account', 'ADMIN'))
  })

  it('没给 account 时账号维度被跳过，counts 里也没有它', async () => {
    const d = await hit()
    expect(d.counts.account).toBeUndefined()
  })

  it('档位没配 accountLimit 时，即使传了 account 也不计（不是「无限额度」，是「这一档没有这个维度」）', async () => {
    const noAccount = defineTier({ ...TIER, name: 'no-account', accountLimit: undefined })
    const d = await decide({
      tier: noAccount,
      store,
      keys: { client: CLIENT, edge: EDGE, account: 'a' },
    })
    expect(d.counts.account).toBeUndefined()
  })

  it('三个维度都会被计数，不会在第一个命中的维度上短路', async () => {
    for (let i = 0; i < 4; i += 1) await hit({ account: 'acct' })
    const d = await hit({ account: 'acct' })
    expect(d.allowed).toBe(false)
    expect(d.hitDimension).toBe('client')
    // 客户端维度已经命中了，但账号维度照样在数——否则攻击者换个 IP 继续打的时候，
    // 账号维度还是干净的。
    expect(d.counts.account).toBe(5)
    expect(d.counts.edge).toBe(5)
  })

  it('dimensions 只算指定维度（守卫算 client+edge，登录流程再补算 account）', async () => {
    const d = await decide({
      tier: TIER,
      store,
      keys: { client: CLIENT, edge: EDGE, account: 'acct' },
      dimensions: ['account'],
    })
    expect(d.counts).toEqual({ account: 1 })
  })

  it('scope 把不同环境的计数隔开（共用一个 Redis 时预发压测不会打满生产额度）', async () => {
    for (let i = 0; i < 4; i += 1) {
      await decide({ tier: TIER, store, keys: { client: CLIENT, edge: EDGE }, scope: 'staging' })
    }
    const prod = await decide({ tier: TIER, store, keys: { client: CLIENT, edge: EDGE } })
    expect(prod.allowed).toBe(true)
  })
})

describe('decide 在 store 故障时弱化但不放行', () => {
  it('Redis 抛错时退回进程内计数，照样拦得住', async () => {
    const broken = brokenStore()
    const run = () => decide({ tier: TIER, store: broken, keys: { client: CLIENT, edge: EDGE } })
    for (let i = 0; i < 4; i += 1) {
      const d = await run()
      expect(d.degraded).toBe(true)
    }
    const blocked = await run()
    expect(blocked.allowed).toBe(false)
    expect(blocked.degraded).toBe(true)
  })

  it('降级时也给得出 retryAfterSec', async () => {
    const broken = brokenStore()
    for (let i = 0; i < 4; i += 1)
      await decide({ tier: TIER, store: broken, keys: { client: CLIENT, edge: EDGE } })
    const d = await decide({ tier: TIER, store: broken, keys: { client: CLIENT, edge: EDGE } })
    expect(d.retryAfterSec).toBeGreaterThan(0)
  })

  it('正常路径 degraded 恒为 false（别让调用方一直打降级 error 日志）', async () => {
    expect((await hit()).degraded).toBe(false)
  })

  it('Redis 恢复之后回到 Redis 计数，degraded 变回 false', async () => {
    let up = false
    const flaky: RateLimitStore = {
      async incr(key, windowSec) {
        if (!up) throw new Error('down')
        return store.incrSync(key, windowSec)
      },
    }
    const run = () => decide({ tier: TIER, store: flaky, keys: { client: CLIENT, edge: EDGE } })
    expect((await run()).degraded).toBe(true)
    up = true
    expect((await run()).degraded).toBe(false)
  })

  it('只有部分维度失败时，成功的那些仍走 Redis', async () => {
    const partial: RateLimitStore = {
      async incr(key, windowSec) {
        if (key.includes(':e:')) throw new Error('这一个 key 恰好落在挂掉的分片上')
        return store.incrSync(key, windowSec)
      },
    }
    const d = await decide({ tier: TIER, store: partial, keys: { client: CLIENT, edge: EDGE } })
    expect(d.degraded).toBe(true)
    expect(d.counts.client).toBe(1)
    expect(d.counts.edge).toBe(1)
  })
})

describe('RedisRateLimitStore', () => {
  it('只在计数器新建时设 TTL（每次都设会让窗口永不过期）', async () => {
    const redis = {
      incr: vi.fn<(k: string) => Promise<number>>(),
      expire: vi.fn(async () => 1),
      ttl: vi.fn(async () => 60),
    }
    const s = new RedisRateLimitStore(redis)
    redis.incr.mockResolvedValueOnce(1)
    await s.incr('k', 60)
    redis.incr.mockResolvedValueOnce(3)
    await s.incr('k', 60)
    expect(redis.expire).toHaveBeenCalledTimes(1)
  })

  it('第二次自增时发现 key 没有 TTL（崩在两条命令之间）会补一次 EXPIRE', async () => {
    const redis = {
      incr: vi.fn(async () => 2),
      expire: vi.fn(async () => 1),
      ttl: vi.fn(async () => -1),
    }
    await new RedisRateLimitStore(redis).incr('k', 60)
    expect(redis.expire).toHaveBeenCalledWith('k', 60)
  })

  it('ttlSec 把 Redis 的 -1/-2 归一成 null', async () => {
    const redis = { incr: async () => 1, expire: async () => 1, ttl: async () => -2 }
    expect(await new RedisRateLimitStore(redis).ttlSec('k')).toBeNull()
  })
})
