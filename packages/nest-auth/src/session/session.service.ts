/**
 * 会话集合：**token 有效 ≠ 会话存活**。
 *
 * ## 为什么无状态 JWT 还要在 Redis 里存一份
 *
 * JWT 一旦签出去，在 exp 之前谁也拦不住它——这正是「改密之后旧 token 还能用 8 小时」
 * 的成因。所以本框架把 JWT 只当**身份凭证**，是否**仍然有效**由 Redis 里的会话集合说了算：
 * 每次签发把 jti 记进集合，`GlobalAuthGuard` 每请求查一次 `isAlive`，
 * 改密/登出就 `revokeAll` / `revokeOne`。代价是每请求一次 Redis 读（O(1) 的 GET），
 * 换来的是「立即失效」这条能力——安全事件响应里，没有这条就只能等 exp。
 *
 * ## 两把 key（不能合成一把）
 *
 * ```
 * auth:session:{kind}:{sub}          Set<jti>            列出「这个人开了哪几端」
 * auth:session:{kind}:{sub}:{jti}    "<签发毫秒时间戳>"   带 TTL，到期自动消失
 * ```
 *
 * 只有集合的话，成员不会自己过期，一个用户登录一年就攒出一坨死 jti；
 * 只有单 key 的话，`SCAN` 才能列出某人的所有会话——`SCAN` 在生产库上是要命的。
 * 两把配合：判活看单 key（O(1)），列端看集合，集合里的死成员在下次 {@link add}
 * 时顺手清掉（惰性 GC，和 Redis 自己的过期策略同构）。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { AUTH_CLOCK, AUTH_CONCURRENCY, AUTH_REDIS } from '../tokens'
import type { Clock } from '../clock'
import type { AuthRedis } from '../redis'
import type { TokenKind } from '../token/jwt-payload'

/** 各 kind 允许同时在线的端数。 */
export type ConcurrencyLimits = Record<TokenKind, number>

/**
 * 默认并发端数。
 *
 * - `staff: 8`——收银机 + 后厨屏 + 老板手机 + 平板，一家店同时开七八端是常态，
 *   卡到 1 会让员工互相把对方踢下线，最后一定会有人来要求「关掉这个功能」。
 * - `platform: 1`——平台超管只应该有一个活跃会话；多出来的那个更可能是被盗，不是并发办公。
 * - `member: 1`——单端。C 端产品若要「手机 + 小程序同时在线」，改这一行即可
 *   （`AuthModule.forRoot({ concurrency: { member: 3 } })`）。
 */
export const DEFAULT_CONCURRENCY: ConcurrencyLimits = {
  platform: 1,
  staff: 8,
  member: 1,
}

/** 会话集合 key。 */
export function sessionSetKey(kind: TokenKind, sub: string): string {
  return `auth:session:${kind}:${sub}`
}

/** 单会话 key（带 TTL）。 */
export function sessionKey(kind: TokenKind, sub: string, jti: string): string {
  return `auth:session:${kind}:${sub}:${jti}`
}

/** 一条在线会话。 */
export interface SessionEntry {
  jti: string
  /** 签发时间（毫秒）。踢最旧就按它排序。 */
  issuedAt: number
}

/**
 * 会话集合服务（蓝图 §4.3）。
 *
 * 所有方法都对 Redis 抖动**保守**：读失败会向上抛，由 `GlobalAuthGuard` 转成 401——
 * 「Redis 挂了就全放行」是把可用性问题换成越权问题，不接受。
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(AUTH_REDIS) private readonly redis: AuthRedis,
    @Inject(AUTH_CONCURRENCY) private readonly limits: ConcurrencyLimits,
    @Inject(AUTH_CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * 登记一条新会话，并在超出端数上限时踢掉最旧的那些。
   *
   * @param kind - 身份类型
   * @param sub - 主体 id
   * @param jti - 本次会话 id
   * @param ttl - 存活秒数，通常等于 access token 的 TTL
   * @returns 因为超限被踢掉的 jti 列表（调用方可以据此发「您已在别处登录」的通知）
   */
  async add(kind: TokenKind, sub: string, jti: string, ttl: number): Promise<string[]> {
    const now = this.clock.now()
    await this.redis.set(sessionKey(kind, sub, jti), String(now), 'EX', ttl)
    await this.redis.sadd(sessionSetKey(kind, sub), jti)
    // 集合本身也要有 TTL，否则用户不再登录后这把 key 会永久驻留。
    // 给足 refresh 的量级（30 天），每次 add 都续期。
    await this.redis.expire(sessionSetKey(kind, sub), Math.max(ttl, 30 * 24 * 60 * 60))

    return this.enforceLimit(kind, sub)
  }

  /**
   * 列出当前存活的会话，按签发时间**从旧到新**排序。
   *
   * 顺带把集合里已经过期的死成员 `SREM` 掉（惰性 GC）。
   */
  async list(kind: TokenKind, sub: string): Promise<SessionEntry[]> {
    const setKey = sessionSetKey(kind, sub)
    const jtis = await this.redis.smembers(setKey)
    const alive: SessionEntry[] = []
    const dead: string[] = []

    for (const jti of jtis) {
      const raw = await this.redis.get(sessionKey(kind, sub, jti))
      if (raw === null) {
        dead.push(jti)
      } else {
        alive.push({ jti, issuedAt: Number(raw) })
      }
    }
    if (dead.length > 0) {
      await this.redis.srem(setKey, ...dead)
    }

    alive.sort((a, b) => a.issuedAt - b.issuedAt)
    return alive
  }

  /** 超出上限就从最旧的开始踢。 */
  private async enforceLimit(kind: TokenKind, sub: string): Promise<string[]> {
    const limit = this.limits[kind]
    if (!Number.isFinite(limit) || limit <= 0) return []

    const alive = await this.list(kind, sub)
    if (alive.length <= limit) return []

    const evicted = alive.slice(0, alive.length - limit)
    for (const entry of evicted) {
      await this.revokeOne(kind, sub, entry.jti)
    }
    return evicted.map((e) => e.jti)
  }

  /** 吊销单条会话（登出、被挤下线）。 */
  async revokeOne(kind: TokenKind, sub: string, jti: string): Promise<void> {
    await this.redis.del(sessionKey(kind, sub, jti))
    await this.redis.srem(sessionSetKey(kind, sub), jti)
  }

  /**
   * 吊销某人的**全部**会话。
   *
   * 改密、被停用、管理员强制下线走这里。这是「立即失效」这条能力的兑现点，
   * 也是本服务存在的全部理由。
   */
  async revokeAll(kind: TokenKind, sub: string): Promise<void> {
    const setKey = sessionSetKey(kind, sub)
    const jtis = await this.redis.smembers(setKey)
    if (jtis.length > 0) {
      await this.redis.del(...jtis.map((jti) => sessionKey(kind, sub, jti)))
    }
    await this.redis.del(setKey)
  }

  /** 这条会话还活着吗。`GlobalAuthGuard` 每请求调一次。 */
  async isAlive(kind: TokenKind, sub: string, jti: string): Promise<boolean> {
    return (await this.redis.get(sessionKey(kind, sub, jti))) !== null
  }
}
