/**
 * `RedisService`：ioredis 的薄封装 + `redis` 健康探针。
 *
 * 薄到什么程度：**不做降级、不做重试、不吞异常**。老项目（knowledge）那份
 * `RedisService` 在连不上时静默退回进程内存，理由是「本地开发也要能跑」——
 * 那个决定的代价是：线上 Redis 抖一下，限流额度立刻变成「额度 × 进程数」，
 * 分布式锁变成「每个进程都是 leader」，而日志里只有一行 warn。
 *
 * 本包的选择相反：**Redis 不可用就响亮地失败**，由 `/health` 的 `redis` 探针
 * 把这台实例摘出去。要在没有 Redis 的机器上开发，就传一个 `ioredis-mock`
 * 进来（`InfraModule.forRoot({ redis })`），而不是让生产代码里长一条降级分支。
 *
 * 从老项目原样搬过来的只有一个方法：{@link RedisService.takeOnce}（`GETDEL`）。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { HealthIndicator } from '@taizan/nest-core'
import { INFRA_KEY_PREFIX, INFRA_REDIS } from '../tokens'
import type { RedisClient } from './redis-client'

/** 默认 key 前缀。同一台 Redis 上常常还跑着别的站，前缀是「别互删」的第一道保险。 */
export const DEFAULT_KEY_PREFIX = 'taizan:'

/** `PING` 探针的默认超时。 */
export const PING_TIMEOUT_MS = 2000

/** 带超时的 `PING` 探针。 */
export class RedisHealthIndicator implements HealthIndicator {
  readonly name = 'redis'

  constructor(
    private readonly client: RedisClient,
    private readonly timeoutMs: number = PING_TIMEOUT_MS,
  ) {}

  /**
   * 探测 Redis。
   *
   * **自带超时**：探针挂死会把 `/health` 一起拖死，而 `/health` 挂死时反向代理拿不到
   * 503，反而不会摘流量——比直接返回 `down` 糟得多。（与 nest-prisma 的 db 探针同理。）
   */
  async check(): Promise<'up' | 'down'> {
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        // cluster-safe-allow: 健康探针自带的超时闹钟，不是业务调度
        timer = setTimeout(
          () => reject(new Error(`[@taizan/nest-infra] redis 探针超时（${this.timeoutMs}ms）`)),
          this.timeoutMs,
        )
      })
      const pong = await Promise.race([this.client.ping(), timeout])
      return typeof pong === 'string' && pong.toUpperCase().includes('PONG') ? 'up' : 'down'
    } catch {
      // 探针不往外抛：`/health` 要的是一个 up/down，不是 500。
      return 'down'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * Redis 访问入口。**所有跨进程共享的状态都必须经过它**——
 * 限流计数、分布式锁、幂等占位、租户缓存、一次性凭据。
 */
@Injectable()
export class RedisService {
  /** `redis` 健康探针。`InfraModule` 在 `onModuleInit` 时注册进 `HealthRegistry`。 */
  readonly healthIndicator: RedisHealthIndicator

  constructor(
    @Inject(INFRA_REDIS) private readonly client: RedisClient,
    @Inject(INFRA_KEY_PREFIX) private readonly prefix: string = DEFAULT_KEY_PREFIX,
  ) {
    this.healthIndicator = new RedisHealthIndicator(client)
  }

  /** 底层客户端。需要本封装没提供的命令时用它，但请先想想是不是该加进封装。 */
  get raw(): RedisClient {
    return this.client
  }

  /** 当前 key 前缀（含结尾的分隔符）。 */
  get keyPrefix(): string {
    return this.prefix
  }

  /** 加前缀。所有对外暴露的 key 参数都是**不带前缀**的逻辑 key。 */
  key(logicalKey: string): string {
    return `${this.prefix}${logicalKey}`
  }

  async get(logicalKey: string): Promise<string | null> {
    return this.client.get(this.key(logicalKey))
  }

  async set(logicalKey: string, value: string, ttlMs: number): Promise<void> {
    await this.client.set(this.key(logicalKey), value, 'PX', ttlMs)
  }

  /**
   * `SET key value PX ttl NX`：只在 key 不存在时写入。
   *
   * @returns 写成功返回 `true`；key 已存在返回 `false`
   */
  async setNx(logicalKey: string, value: string, ttlMs: number): Promise<boolean> {
    const res = await this.client.set(this.key(logicalKey), value, 'PX', ttlMs, 'NX')
    return res === 'OK'
  }

  async del(...logicalKeys: string[]): Promise<number> {
    if (logicalKeys.length === 0) return 0
    return this.client.del(...logicalKeys.map((k) => this.key(k)))
  }

  /**
   * 取一次就删（`GETDEL`）。**一次性凭据必须用这个**。
   *
   * 从 knowledge `apps/api/src/infra/redis.service.ts` 原样搬过来的理由也一并搬：
   * 先 `GET` 再 `DEL` 的话，两个进程可能同时 `GET` 到同一个 state 都判为有效，
   * 而 state 的全部意义就在于只能用一次。蓝图 §8 第 12 条把这条写成了机器可扫的约束。
   */
  async takeOnce(logicalKey: string): Promise<string | null> {
    return this.client.getdel(this.key(logicalKey))
  }

  async pexpire(logicalKey: string, ttlMs: number): Promise<number> {
    return this.client.pexpire(this.key(logicalKey), ttlMs)
  }

  async pttl(logicalKey: string): Promise<number> {
    return this.client.pttl(this.key(logicalKey))
  }

  /** 执行 Lua 脚本。key 由调用方自己加前缀（用 {@link RedisService.key}）。 */
  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args)
  }

  /**
   * 按 pattern 扫出全部 key（**不带前缀**返回，与入参口径一致）。
   *
   * 用 `SCAN` 不用 `KEYS`：`KEYS` 是 O(N) 且**单线程阻塞**，
   * 在有几十万 key 的生产库上执行一次能把整个 Redis 卡住几百毫秒——
   * 所有依赖 Redis 的接口（限流、锁、缓存）在那几百毫秒里一起超时。
   *
   * @param logicalPattern - 不带前缀的匹配式，例如 `t:{tenantId}:goods:*`
   */
  async scanKeys(logicalPattern: string, batch = 200): Promise<string[]> {
    const pattern = this.key(logicalPattern)
    const found: string[] = []
    let cursor = '0'
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', batch)
      cursor = next
      for (const k of keys) {
        found.push(k.startsWith(this.prefix) ? k.slice(this.prefix.length) : k)
      }
    } while (cursor !== '0')
    return found
  }
}
