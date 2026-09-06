/**
 * 三套独立密钥的 JWT 签发与校验（蓝图 §4.3、§9 knowledge 第 5 条）。
 *
 * ## 为什么是 `jose` 而不是 `jsonwebtoken` / `@nestjs/jwt`
 *
 * `jose` 是纯 ESM、零依赖、基于 WebCrypto 的实现，异步 API 天然不阻塞事件循环；
 * `jsonwebtoken` 的同步 `verify` 在每个请求上都占一小段 CPU，而验签是**每请求**都要做的事。
 * `@nestjs/jwt` 只是 `jsonwebtoken` 的一层薄封装，还会把 `JwtModule` 的全局配置带进来——
 * 而本包恰恰需要**三套配置并存**，一个全局单例反而碍事。
 *
 * ## 三条硬约束
 *
 * 1. **算法白名单只有 HS256**：`jose` 的 `jwtVerify` 不传 `algorithms` 时会按 header 里的
 *    `alg` 走，那正是 `alg: none` 与 HS/RS 混淆攻击的入口。这里显式钉死。
 * 2. **payload.kind 必须与请求的 kind 逐字相等**，不等就抛 1140102。理由见 `jwt-payload.ts`。
 * 3. **过期与其它验签失败分开报**：过期是 1140101（前端静默刷新或跳登录），
 *    签名不对是 1140100（多半是伪造，前端只能跳登录）。合并成一个码，前端就没法区分
 *    「该刷新」和「该报警」。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ulid } from '@taizan/contracts'
import { BizException, ConfigService } from '@taizan/nest-core'
import { jwtVerify, SignJWT, type JWTPayload } from 'jose'
import { AUTH_CLOCK, AUTH_REDIS, AUTH_TTL } from '../tokens'
import type { Clock } from '../clock'
import type { AuthRedis } from '../redis'
import { takeOnce } from '../redis'
import { SessionService } from '../session/session.service'
import {
  AUTH_ERRORS,
  isTokenKind,
  TOKEN_KINDS,
  TOKEN_PAYLOAD_VERSION,
  type RefreshPayload,
  type SignablePayload,
  type TokenKind,
  type TokenPayload,
} from './jwt-payload'
import type { TokenTtlConfig } from './ttl'

/** 只允许这一个算法，见文件头第 1 条。 */
const ALG = 'HS256'

/** env 里三把密钥的字段名。 */
const SECRET_ENV = {
  platform: 'JWT_SECRET_PLATFORM',
  staff: 'JWT_SECRET_STAFF',
  member: 'JWT_SECRET_MEMBER',
} as const

/** refresh token 在 Redis 里的 key。 */
export function refreshKey(kind: TokenKind, sub: string, rid: string): string {
  return `auth:refresh:${kind}:${sub}:${rid}`
}

/** {@link TokenService.rotateRefresh} 的返回。 */
export interface TokenPair {
  access: string
  refresh: string
}

/**
 * JWT 服务。
 *
 * 三把密钥在构造时一次性编码成 `Uint8Array` 并按 kind 存好——每次签发都
 * `new TextEncoder().encode()` 一遍纯属浪费。
 */
@Injectable()
export class TokenService {
  private readonly secrets: Record<TokenKind, Uint8Array>

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(AUTH_TTL) private readonly ttl: TokenTtlConfig,
    @Inject(AUTH_REDIS) private readonly redis: AuthRedis,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AUTH_CLOCK) private readonly clock: Clock,
  ) {
    const encoder = new TextEncoder()
    this.secrets = {
      platform: encoder.encode(config.get(SECRET_ENV.platform)),
      staff: encoder.encode(config.get(SECRET_ENV.staff)),
      member: encoder.encode(config.get(SECRET_ENV.member)),
    }
  }

  /**
   * 签发一个 access token。
   *
   * **不负责登记会话**——那是 {@link SessionService.add} 的事，由 `AuthFlowService`
   * 或调用方按业务语义决定（换店重签要新开一条会话，签一个不入会话的临时 token 也应该可能）。
   *
   * @param kind - 身份类型，决定用哪把密钥、多长 TTL
   * @param payload - 除 `kind` 外的载荷；`jti` 不传则自动生成 ULID
   * @param ttlSec - 覆盖默认 TTL（秒）
   * @returns 紧凑格式的 JWT
   */
  async sign(kind: TokenKind, payload: SignablePayload, ttlSec?: number): Promise<string> {
    const jti = payload.jti ?? ulid()
    const seconds = ttlSec ?? this.ttl.access[kind]
    const nowSec = Math.floor(this.clock.now() / 1000)

    const claims: JWTPayload = {
      kind,
      sub: payload.sub,
      jti,
      ver: payload.ver ?? TOKEN_PAYLOAD_VERSION,
    }
    // 显式判 undefined 再赋值：platform token 里出现一个 tenantId 键本身就会误导
    // 排查的人「是不是解析丢了」，宁可整个键不存在。
    if (payload.tenantId !== undefined) claims.tenantId = payload.tenantId
    if (payload.accountId !== undefined) claims.accountId = payload.accountId

    return new SignJWT(claims)
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + seconds)
      .sign(this.secrets[kind])
  }

  /**
   * 校验并解出载荷。
   *
   * @param kind - 期望的身份类型
   * @param token - 紧凑格式 JWT（**不含** `Bearer ` 前缀，剥前缀是守卫的事）
   * @throws `BizException` 1140101（已过期）/ 1140102（kind 不符）/ 1140100（其余一切失败）
   */
  async verify(kind: TokenKind, token: string): Promise<TokenPayload> {
    let claims: JWTPayload
    try {
      const result = await jwtVerify(token, this.secrets[kind], {
        algorithms: [ALG],
        currentDate: new Date(this.clock.now()),
      })
      claims = result.payload
    } catch (error) {
      // jose 的过期错误 code 是 ERR_JWT_EXPIRED。用 code 而不是 instanceof：
      // monorepo 里 jose 可能被装成两份实例，那时 instanceof 会莫名其妙不成立。
      if ((error as { code?: string }).code === 'ERR_JWT_EXPIRED') {
        throw new BizException(AUTH_ERRORS.TOKEN_EXPIRED)
      }
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED)
    }

    // refresh token 拿来当 access 用，直接拒。同密钥同算法，只有 typ 能区分它们。
    if (claims.typ === 'refresh') {
      throw new BizException(AUTH_ERRORS.KIND_MISMATCH, 'refresh token 不能用于访问接口')
    }
    if (!isTokenKind(claims.kind) || claims.kind !== kind) {
      throw new BizException(AUTH_ERRORS.KIND_MISMATCH)
    }
    if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string') {
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED)
    }

    const payload: TokenPayload = {
      kind,
      sub: claims.sub,
      jti: claims.jti,
      ver: typeof claims.ver === 'number' ? claims.ver : 0,
    }
    if (typeof claims.tenantId === 'string') payload.tenantId = claims.tenantId
    if (typeof claims.accountId === 'string') payload.accountId = claims.accountId
    return payload
  }

  /**
   * 签发一个 refresh token 并把它登记进 Redis。
   *
   * ## 为什么 refresh 要落 Redis，access 不用
   *
   * access 的失效兜底是 exp（最长 8 小时）；refresh 活 30 天，光靠 exp 兜不住。
   * 更关键的是**轮换**：refresh 必须一次性——用过就作废。这件事在无状态 token 上
   * 做不到，必须有一处服务端记录说「这个 rid 还没被用过」。
   *
   * @param kind - 身份类型
   * @param sub - 主体 id
   * @param extra - 要一起带到新 access 上的字段（tenantId / accountId）
   */
  async issueRefresh(
    kind: TokenKind,
    sub: string,
    extra: { tenantId?: string; accountId?: string } = {},
  ): Promise<string> {
    const rid = ulid()
    const nowSec = Math.floor(this.clock.now() / 1000)

    const claims: JWTPayload = { kind, sub, rid, ver: TOKEN_PAYLOAD_VERSION, typ: 'refresh' }
    if (extra.tenantId !== undefined) claims.tenantId = extra.tenantId
    if (extra.accountId !== undefined) claims.accountId = extra.accountId

    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + this.ttl.refresh)
      .sign(this.secrets[kind])

    // 值只是个占位（存签发毫秒时间戳，排查时有用）。判定「有效」看 key 在不在。
    await this.redis.set(
      refreshKey(kind, sub, rid),
      String(this.clock.now()),
      'EX',
      this.ttl.refresh,
    )
    return token
  }

  /**
   * 用 refresh 换一对新 token，**并一次性核销旧 refresh**。
   *
   * ## 一次性是怎么保证的
   *
   * 用 `GETDEL`（见 `redis.ts` 的 `takeOnce`）：读和删在 Redis 服务端是一次操作，
   * 两个并发请求只有一个能拿到值，另一个拿到 `null` 直接 401。
   * 用 `GET` 再 `DEL` 两步的话，两个并发请求会同时读到值，refresh 就被重放了一次——
   * 攻击者偷到 refresh 后能和真用户并行地一直换新 token，而且双方都察觉不到。
   *
   * 代价：真用户在弱网下并发重试刷新，会有一个请求拿到 401 并被迫重登。刻意付这个代价。
   *
   * @param token - 旧的 refresh token
   * @returns 新的 access + 新的 refresh
   * @throws `BizException` 1140100 / 1140101
   */
  async rotateRefresh(token: string): Promise<TokenPair> {
    const payload = await this.verifyRefresh(token)

    const taken = await takeOnce(this.redis, refreshKey(payload.kind, payload.sub, payload.rid))
    if (taken === null) {
      // 要么已经用过（重放 / 并发），要么已过期，要么被 revokeAll 清掉了。
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED, '刷新凭证已失效，请重新登录')
    }

    const extra: { tenantId?: string; accountId?: string } = {}
    if (payload.tenantId !== undefined) extra.tenantId = payload.tenantId
    if (payload.accountId !== undefined) extra.accountId = payload.accountId

    const jti = ulid()
    const access = await this.sign(payload.kind, {
      sub: payload.sub,
      jti,
      ver: TOKEN_PAYLOAD_VERSION,
      ...extra,
    })
    // 新 access 必须进会话集合，否则守卫的 isAlive 会立刻判它死。
    await this.sessions.add(payload.kind, payload.sub, jti, this.ttl.access[payload.kind])
    const refresh = await this.issueRefresh(payload.kind, payload.sub, extra)
    return { access, refresh }
  }

  /**
   * 单独校验 refresh（**不核销**）。
   *
   * kind 藏在密文里，所以三把密钥都试一遍——只有 3 次 HMAC，成本可忽略。
   * 反过来「先用不验签的 decode 读出 kind、再挑密钥」才是真危险：
   * 攻击者可以自由指定 header 里的 kind，把 member 的串引到 platform 密钥上去验。
   */
  async verifyRefresh(token: string): Promise<RefreshPayload> {
    for (const kind of TOKEN_KINDS) {
      let claims: JWTPayload
      try {
        const result = await jwtVerify(token, this.secrets[kind], {
          algorithms: [ALG],
          currentDate: new Date(this.clock.now()),
        })
        claims = result.payload
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_JWT_EXPIRED') {
          throw new BizException(AUTH_ERRORS.TOKEN_EXPIRED)
        }
        continue
      }

      if (claims.typ !== 'refresh' || claims.kind !== kind) break
      if (typeof claims.sub !== 'string' || typeof claims.rid !== 'string') break

      const result: RefreshPayload = {
        kind,
        sub: claims.sub,
        rid: claims.rid,
        ver: typeof claims.ver === 'number' ? claims.ver : 0,
        typ: 'refresh',
      }
      if (typeof claims.tenantId === 'string') result.tenantId = claims.tenantId
      if (typeof claims.accountId === 'string') result.accountId = claims.accountId
      return result
    }
    throw new BizException(AUTH_ERRORS.UNAUTHENTICATED)
  }

  /** 吊销某人名下的一条 refresh（登出时配合 `SessionService.revokeOne` 用）。 */
  async revokeRefresh(kind: TokenKind, sub: string, rid: string): Promise<void> {
    await this.redis.del(refreshKey(kind, sub, rid))
  }
}
