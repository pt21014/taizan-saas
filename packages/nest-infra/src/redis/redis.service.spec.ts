import RedisMock from 'ioredis-mock'
import type Redis from 'ioredis'
import { beforeEach, describe, expect, it } from 'vitest'
import { RedisService, RedisHealthIndicator, DEFAULT_KEY_PREFIX } from './redis.service'
import type { RedisClient } from './redis-client'

/**
 * 静态断言：真 ioredis 仍然满足 `RedisClient`。
 *
 * 结构化类型最怕的就是上游改了签名而我们毫无察觉——那时候「传 ioredis 进来」
 * 会在业务项目里报类型错，而不是在框架包的 CI 里。
 */
type AssertAssignable<T extends U, U> = T
/** 编译期就会红：真 ioredis 一旦不再满足 `RedisClient`，`tsc --noEmit` 直接失败。 */
type _RealIoredisSatisfiesRedisClient = AssertAssignable<Redis, RedisClient>

it('RedisClient 与真 ioredis 的签名兼容（静态断言，见上面的类型别名）', () => {
  const witness: _RealIoredisSatisfiesRedisClient | undefined = undefined
  expect(witness).toBeUndefined()
})

describe('RedisService', () => {
  let client: RedisClient
  let redis: RedisService

  beforeEach(() => {
    client = new RedisMock() as unknown as RedisClient
    redis = new RedisService(client, DEFAULT_KEY_PREFIX)
  })

  it('所有 key 都带前缀', async () => {
    await redis.set('foo', 'bar', 1000)
    expect(redis.key('foo')).toBe('taizan:foo')
    expect(await client.get('taizan:foo')).toBe('bar')
    // 不带前缀的裸 key 读不到——证明前缀是真的加上去了，不是只写在返回值里
    expect(await client.get('foo')).toBeNull()
  })

  it('setNx 只有第一次成功', async () => {
    expect(await redis.setNx('k', 'first', 5000)).toBe(true)
    expect(await redis.setNx('k', 'second', 5000)).toBe(false)
    expect(await redis.get('k')).toBe('first')
  })

  // 用例 ⑧
  it('takeOnce 第二次返回 null（GETDEL 原子核销）', async () => {
    await redis.set('state:abc', 'payload', 5000)
    expect(await redis.takeOnce('state:abc')).toBe('payload')
    expect(await redis.takeOnce('state:abc')).toBeNull()
  })

  it('scanKeys 返回去掉前缀的逻辑 key，且只匹配 pattern', async () => {
    await redis.set('t:T1:goods:a', '1', 5000)
    await redis.set('t:T1:goods:b', '1', 5000)
    await redis.set('t:T2:goods:c', '1', 5000)
    const keys = await redis.scanKeys('t:T1:goods:*')
    expect(keys.sort()).toEqual(['t:T1:goods:a', 't:T1:goods:b'])
  })

  it('redis 探针 PING 通就是 up', async () => {
    expect(await redis.healthIndicator.check()).toBe('up')
    expect(redis.healthIndicator.name).toBe('redis')
  })

  it('redis 探针在 PING 抛错时返回 down 而不是往外抛', async () => {
    const broken = {
      ping: (): Promise<string> => Promise.reject(new Error('connection refused')),
    } as unknown as RedisClient
    await expect(new RedisHealthIndicator(broken).check()).resolves.toBe('down')
  })

  it('redis 探针自带超时：PING 挂死时返回 down，不会把 /health 一起拖死', async () => {
    const hanging = {
      ping: (): Promise<string> => new Promise<string>(() => undefined),
    } as unknown as RedisClient
    await expect(new RedisHealthIndicator(hanging, 80).check()).resolves.toBe('down')
  })
})
