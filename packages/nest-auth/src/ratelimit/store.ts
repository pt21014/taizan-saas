/**
 * 把 {@link AuthRedis} 适配成 `@taizan/ratelimit-core` 的 `RateLimitStore`。
 *
 * 为什么不直接用 ratelimit-core 里的 `RedisRateLimitStore`：那个类要的是
 * `{ incr, expire, ttl }` 三个方法的裸对象，而本包统一从 {@link AUTH_REDIS} 拿句柄
 * （下游可能传的是 `ioredis`、也可能是自家封装、测试里是 `InMemoryAuthRedis`）。
 * 这里薄薄一层，把「本包的 Redis 抽象」翻译成「限流包的 store 抽象」，
 * 两个包因此都不用认识对方的 Redis 接口。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { RedisRateLimitStore, type RateLimitStore } from '@taizan/ratelimit-core'
import type { AuthRedis } from '../redis'
import { AUTH_REDIS } from '../tokens'

/**
 * 基于 {@link AUTH_REDIS} 的限流计数 store。
 *
 * Redis 不可用时这里的方法会**抛错**（`ioredis` 连不上就是 reject），
 * 而 `decide` 靠这个异常退回进程内计数——**千万不要**在这里 catch 掉返回 0，
 * 那等于「Redis 一挂限流就消失」，而且不会有任何东西报错。
 */
@Injectable()
export class AuthRedisRateLimitStore implements RateLimitStore {
  private readonly inner: RedisRateLimitStore

  constructor(@Inject(AUTH_REDIS) redis: AuthRedis) {
    this.inner = new RedisRateLimitStore({
      incr: (key) => redis.incr(key),
      expire: (key, seconds) => redis.expire(key, seconds),
      ttl: (key) => redis.ttl(key),
    })
  }

  incr(key: string, windowSec: number): Promise<number> {
    return this.inner.incr(key, windowSec)
  }

  ttlSec(key: string): Promise<number | null> {
    return this.inner.ttlSec(key)
  }
}
