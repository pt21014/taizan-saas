/**
 * Redis 的**最小接口**（结构化类型），以及内存替身。
 *
 * ## 为什么不直接依赖 `ioredis` 的类型
 *
 * 本包只用到 10 个命令。把 `Redis` 整个类作为依赖会有两个后果：一是 `ioredis` 从
 * peer 变成事实上的强依赖（下游想换 `iovalkey`、换集群封装、换自家连接池就得改包）；
 * 二是测试里必须起真 Redis 或引一个 mock 库。声明成结构化接口之后，
 * `ioredis` 的实例天然满足它，测试用 {@link InMemoryAuthRedis} 也满足它。
 *
 * ## 谁提供它
 *
 * `AuthModule.forRoot({ redis })`，注入 token 是 {@link AUTH_REDIS}。
 *
 * @packageDocumentation
 */

/**
 * 本包用到的 Redis 命令集合。
 *
 * 命令名与 `ioredis` 的方法名逐一对齐（小写），所以 `new Redis(url)` 可以直接传进来。
 */
export interface AuthRedis {
  get(key: string): Promise<string | null>
  /**
   * `set key value`，可选 `EX seconds`。
   *
   * 签名照 `ioredis` 的可变参数形态写：`set(k, v)` 与 `set(k, v, 'EX', 60)` 两种调用
   * 都要能过类型检查，所以尾参用 rest。
   */
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(...keys: string[]): Promise<number>
  /** 原子「读并删」。一次性凭据（refresh token、验证码）靠它做核销，见下面的注释。 */
  getdel(key: string): Promise<string | null>
  sadd(key: string, ...members: string[]): Promise<number>
  srem(key: string, ...members: string[]): Promise<number>
  smembers(key: string): Promise<string[]>
  expire(key: string, seconds: number): Promise<number>
  /**
   * 原子自增并返回新值。**限流计数靠它**。
   *
   * 必须是服务端原子操作：`get` + `set` 两步的实现会在同一瞬间涌进来的那批请求上
   * 丢计数，而丢掉的正好是爆破的那种。
   */
  incr(key: string): Promise<number>
  /** 剩余 TTL（秒）。Redis 语义：key 不存在回 `-2`，存在但没设过期回 `-1`。 */
  ttl(key: string): Promise<number>
  /** 预留给需要原子多步的场景（本包暂未使用，留在接口里是为了不做破坏性变更）。 */
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

/**
 * 原子取走一个一次性凭据。
 *
 * `GETDEL` 是 Redis 6.2 才有的命令，好处是「读」和「删」在服务端是一次操作——
 * 用 `GET` + `DEL` 两步的话，两个并发请求会**同时读到同一个值**，refresh token
 * 就能被重放一次，图形验证码就能被并发爆破。这是安全语义，不是性能优化。
 *
 * @param redis - Redis 句柄
 * @param key - 凭据 key
 * @returns 凭据值；不存在（或已被别人取走）返回 `null`
 */
export async function takeOnce(redis: AuthRedis, key: string): Promise<string | null> {
  return redis.getdel(key)
}

interface Entry {
  value: string | undefined
  members: Set<string> | undefined
  /** 绝对过期时间（毫秒），`undefined` 表示不过期。 */
  expiresAt: number | undefined
}

/**
 * 进程内 Redis 替身，只给**测试**用。
 *
 * 语义上刻意贴近真 Redis 的两处：`getdel` 是原子的（单线程 JS 天然满足）、
 * 过期是**惰性**的（读到才判断，和 Redis 的 lazy expiration 一致），
 * 所以测试里推进时钟就能让 key 过期，不需要真的等。
 */
export class InMemoryAuthRedis implements AuthRedis {
  private readonly store = new Map<string, Entry>()

  /** @param now - 时间源，默认 `Date.now`。测试里传一个可推进的假时钟。 */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 当前存活的 key 数量（测试断言用）。 */
  get size(): number {
    this.sweep()
    return this.store.size
  }

  /** 清空。 */
  flush(): void {
    this.store.clear()
  }

  private sweep(): void {
    const t = this.now()
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= t) {
        this.store.delete(key)
      }
    }
  }

  private read(key: string): Entry | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry
  }

  async get(key: string): Promise<string | null> {
    return this.read(key)?.value ?? null
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<unknown> {
    let expiresAt: number | undefined
    for (let i = 0; i < args.length - 1; i += 1) {
      if (String(args[i]).toUpperCase() === 'EX') {
        expiresAt = this.now() + Number(args[i + 1]) * 1000
      }
    }
    this.store.set(key, { value, members: undefined, expiresAt })
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0
    for (const key of keys) {
      if (this.read(key)) {
        this.store.delete(key)
        n += 1
      }
    }
    return n
  }

  async getdel(key: string): Promise<string | null> {
    const entry = this.read(key)
    if (!entry) return null
    this.store.delete(key)
    return entry.value ?? null
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const entry = this.read(key) ?? { value: undefined, members: new Set(), expiresAt: undefined }
    entry.members ??= new Set()
    let added = 0
    for (const m of members) {
      if (!entry.members.has(m)) {
        entry.members.add(m)
        added += 1
      }
    }
    this.store.set(key, entry)
    return added
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const entry = this.read(key)
    if (!entry?.members) return 0
    let removed = 0
    for (const m of members) {
      if (entry.members.delete(m)) removed += 1
    }
    // Redis 的语义：集合空了这个 key 就不存在了。
    if (entry.members.size === 0) this.store.delete(key)
    return removed
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.read(key)?.members ?? [])]
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.read(key)
    if (!entry) return 0
    entry.expiresAt = this.now() + seconds * 1000
    return 1
  }

  async incr(key: string): Promise<number> {
    const entry = this.read(key)
    const next = Number(entry?.value ?? '0') + 1
    if (entry) {
      entry.value = String(next)
    } else {
      // 真 Redis 的 INCR 会建一个**没有 TTL** 的 key，调用方随后自己 EXPIRE。
      this.store.set(key, { value: String(next), members: undefined, expiresAt: undefined })
    }
    return next
  }

  async ttl(key: string): Promise<number> {
    const entry = this.read(key)
    if (!entry) return -2
    if (entry.expiresAt === undefined) return -1
    return Math.ceil((entry.expiresAt - this.now()) / 1000)
  }

  async eval(_script: string, _numKeys: number, ..._args: (string | number)[]): Promise<unknown> {
    throw new Error('[@taizan/nest-auth] InMemoryAuthRedis 不支持 eval')
  }
}
