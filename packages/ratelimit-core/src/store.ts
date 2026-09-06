/**
 * 计数后端。
 *
 * ## 为什么是「固定窗口」而不是「滑动窗口」
 *
 * 两种都能用，这里**选固定窗口**（`INCR` + 首次 `EXPIRE`），理由三条：
 *
 * 1. **一次往返、天然原子**。滑动窗口要么维护一个有序集合（`ZADD` + `ZREMRANGEBYSCORE`
 *    + `ZCARD`，三条命令，得写 Lua 才原子），要么维护两个相邻窗口做加权估算。
 *    限流是**每个请求都要走一遍**的东西，这点开销与复杂度不值得。
 * 2. **多进程下必须原子**，而 `INCR` 本来就是。pm2 起 4 个进程，
 *    「读-判断-写」三步的实现会在同一瞬间涌进来的那批请求上丢计数——
 *    而丢掉的正好是爆破的那种。
 * 3. 固定窗口的代价是**窗口边界最多放两倍**（窗口末尾打满 + 新窗口开头再打满）。
 *    对「拦爆破」这个目的来说 2 倍无所谓：攻击者要的是几千倍，不是两倍。
 *    真正兜底的是入口维度那条闸。
 *
 * 所以接口只有一个必需方法 {@link RateLimitStore.incr}：**加一并返回当前值**。
 * 想换成滑动窗口的下游，自己实现一个满足这个签名的 store 即可，
 * {@link decide} 不关心里面是怎么数的。
 *
 * @packageDocumentation
 */

/**
 * 计数后端接口。**注入进来**，本包不认识 Redis。
 *
 * 实现必须满足两条语义，否则限流会静默失效：
 *
 * 1. **TTL 只在计数器诞生时设一次**。每次 `incr` 都重设 TTL 的实现，会让持续打的攻击者
 *    的窗口永远不过期——听起来更严，实际是：正常用户的窗口也永远不过期，
 *    他被拦一次就再也进不来了。
 * 2. **返回自增后的值**（第一次调用返回 1）。
 */
export interface RateLimitStore {
  /**
   * 给 `key` 加一并返回自增后的计数。
   *
   * @param key - 限流 key，由 {@link buildKey} 生成
   * @param windowSec - 窗口长度（秒）。**只有计数器是新建的时候**才拿它设 TTL
   * @returns 自增后的计数
   * @throws 后端不可用时应当**抛错**（不要吞掉返回 0）——{@link decide} 靠这个异常
   *   判断要不要退回进程内计数。返回 0 会被当成「这个 key 一次都没被打过」，等于放行
   */
  incr(key: string, windowSec: number): Promise<number>

  /**
   * 剩余窗口（秒）。可选：不实现的话 {@link decide} 用整个窗口长度当 `retryAfterSec`，
   * 只是让用户多等一会儿，不影响正确性。
   *
   * @returns 剩余秒数；key 不存在或没有 TTL 返回 `null`
   */
  ttlSec?(key: string): Promise<number | null>
}

/**
 * 限流 key 的唯一生成处。
 *
 * 形状：`rl:{tier}:{c|e|a}:{value}`。维度用单字母是因为这些 key 在 Redis 里会有很多，
 * 而它们的生命周期只有一个窗口，可读性的价值低于内存占用。
 *
 * `scope` 用来给多租户/多环境的部署隔开计数（同一个 Redis 被两套环境共用时，
 * 不隔开会让预发环境的压测把生产的额度打满）。
 */
export function buildKey(
  tier: string,
  dimension: 'client' | 'edge' | 'account',
  value: string,
  scope?: string,
): string {
  const dim = dimension === 'client' ? 'c' : dimension === 'edge' ? 'e' : 'a'
  // 账号维度统一小写：`Admin` 和 `ADMIN` 是同一个人，分成两个桶等于额度翻倍。
  const normalized = dimension === 'account' ? value.toLowerCase() : value
  const prefix = scope ? `rl:${scope}` : 'rl'
  return `${prefix}:${tier}:${dim}:${normalized}`
}

interface Counter {
  count: number
  /** 绝对过期时间（毫秒）。 */
  resetAt: number
}

/**
 * 进程内计数 store。
 *
 * 两个用途：
 * 1. **测试**；
 * 2. **Redis 不可用时的降级底座**（{@link decide} 内部持有一个，见那边的注释）。
 *
 * 生产的常规路径**不要**用它：pm2 起 N 个进程时，实际额度会变成「配置值 × N」，
 * 而那正好是爆破者需要的那个倍数。
 */
export class MemoryRateLimitStore implements RateLimitStore {
  // process-local: 这是「进程内计数」这件事本身的实现，不是缓存。
  // 常规路径走 Redis（见 decide 的降级注释），它只在 Redis 不可用时兜底与测试里使用。
  private readonly counters = new Map<string, Counter>()

  /** @param now - 时间源，默认 `Date.now`。测试里传可推进的假时钟 */
  constructor(private readonly now: () => number = () => Date.now()) {}

  async incr(key: string, windowSec: number): Promise<number> {
    return this.incrSync(key, windowSec)
  }

  /**
   * 同步版。降级路径在 `catch` 里调它，避免再套一层 await。
   *
   * @param at - 覆盖时间源（毫秒）。`decide` 把它收到的 `now` 透下来，
   *   这样降级路径在测试里也能靠推进假时钟来过窗口
   */
  incrSync(key: string, windowSec: number, at?: number): number {
    const t = at ?? this.now()
    const existing = this.counters.get(key)
    if (!existing || existing.resetAt <= t) {
      this.counters.set(key, { count: 1, resetAt: t + windowSec * 1000 })
      return 1
    }
    existing.count += 1
    return existing.count
  }

  async ttlSec(key: string): Promise<number | null> {
    return this.ttlSecSync(key)
  }

  /** 同步版，同 {@link incrSync}。 */
  ttlSecSync(key: string, at?: number): number | null {
    const entry = this.counters.get(key)
    if (!entry) return null
    const remain = entry.resetAt - (at ?? this.now())
    return remain > 0 ? Math.ceil(remain / 1000) : null
  }

  /** 清掉已过期的计数器。长期运行的进程要定期调，否则 Map 只增不减。 */
  sweep(): void {
    const t = this.now()
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= t) this.counters.delete(key)
    }
  }

  /** 当前计数器个数（测试断言用）。 */
  get size(): number {
    return this.counters.size
  }

  /** 全清。 */
  reset(): void {
    this.counters.clear()
  }
}

/**
 * Redis 适配器需要的**最小命令集**。
 *
 * 只声明结构化类型、不 import `ioredis`：本包零框架依赖，而 `ioredis` 的实例
 * 天然满足这三个方法。下游想换 `iovalkey`、换集群封装、换自家连接池都不用改这里。
 */
export interface RedisLike {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number | unknown>
  ttl(key: string): Promise<number>
}

/**
 * Redis 计数 store。
 *
 * `INCR` 之后**只在返回 1 时**才 `EXPIRE`——也就是「这个计数器是我刚创建的」。
 * 每次都 EXPIRE 的写法会把固定窗口变成「只要有人一直打就永不过期」，
 * 结果是被拦住的正常用户永远解不了封。
 *
 * 两条命令之间进程崩了会留下一个**没有 TTL 的 key**（永久占着，且那个人永远被拦）。
 * 概率极低但后果是「某个用户永久登不上」，所以 {@link ttlSec} 读到 `-1`（无 TTL）时
 * 会顺手补一次 EXPIRE。
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisLike) {}

  async incr(key: string, windowSec: number): Promise<number> {
    const n = await this.redis.incr(key)
    if (n === 1) {
      await this.redis.expire(key, windowSec)
    } else if (n > 1) {
      // 补救上面说的那个「崩在两条命令中间」的极小概率场景。
      // 每次多一条 TTL 查询不划算，所以只在计数已经触及个位数上限附近时才查——
      // 这里用一个更省的判断：只在 n 恰好是 2 的时候查一次（紧跟创建那次）。
      if (n === 2) {
        const ttl = await this.redis.ttl(key)
        if (ttl === -1) await this.redis.expire(key, windowSec)
      }
    }
    return n
  }

  async ttlSec(key: string): Promise<number | null> {
    const ttl = await this.redis.ttl(key)
    return ttl > 0 ? ttl : null
  }
}
