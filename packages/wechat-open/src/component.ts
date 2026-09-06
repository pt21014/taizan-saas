/**
 * 平台级凭据链：`component_access_token` 与预授权码。
 *
 * 搬自 knowledge `infra/wechat-open/component.service.ts`，去掉 Nest / Prisma / Redis 依赖，
 * 把「存哪儿」收成 {@link TokenCache} 与 {@link TicketStore} 两个注入口。
 * 保留下来的三条经验（每条都对应一次线上故障）：
 *
 * 1. **提前刷新**：卡在最后一秒去换新的，正好赶上并发请求时会有几个用到刚过期的 token。
 * 2. **并发强刷要搭同一趟车**：微信一签发新 token 就把旧的作废，两个并发的强刷会互相拆台，
 *    后换的把先换的换废，结果是「刷新了反而更坏」。
 * 3. **40001 要能自愈**：任何在别处换过一次 token 的动作（另一套工具、一个诊断脚本、
 *    微信自己轮换）都会让缓存的那份当场失效。没有自愈路径就会抱着一个死 token 调到 TTL 到期，
 *    而**表现是所有列表都变成空的**——不是报错，是「看起来什么都没有」。
 */

import { refreshAuthorizerToken } from './authorizer'
import { wechatOpenError } from './errors'
import type {
  AuthorizerTokenResult,
  CachedToken,
  Clock,
  ComponentConfig,
  HttpClient,
  TicketStore,
  TokenCache,
} from './types'

const API_BASE = 'https://api.weixin.qq.com/cgi-bin/component'

/** 提前 5 分钟换新的 */
const DEFAULT_REFRESH_MARGIN_SEC = 300

/** 微信「access_token 无效 / 已过期」的两个 errcode */
export const TOKEN_INVALID_ERRCODES = [40001, 42001] as const

/** 微信接口的通用响应壳：**永远 HTTP 200**，错误在 body 里 */
interface WxResponse {
  errcode?: number
  errmsg?: string
}

export interface ComponentClientOptions {
  config: ComponentConfig
  http: HttpClient
  ticketStore: TicketStore
  tokenCache: TokenCache
  /** 提前多少秒换新 token，缺省 300 */
  refreshMarginSec?: number
  /** 拨表用，缺省 `Date.now` */
  now?: Clock
  /** 私有化 / 测试时覆盖，缺省微信官方地址 */
  apiBase?: string
}

/** token 缓存的 key。带上 componentAppId，一套代码跑多个开放平台账号时不会串 */
export function componentTokenKey(componentAppId: string): string {
  return `wxopen:component:${componentAppId}`
}

/** 授权方 token 缓存的 key */
export function authorizerTokenKey(componentAppId: string, authorizerAppId: string): string {
  return `wxopen:authorizer:${componentAppId}:${authorizerAppId}`
}

/**
 * 第三方平台客户端。一个开放平台账号一个实例。
 *
 * 有状态的只有两样：进程内的「正在刷新」promise（并发去重用）与「上一个被换掉的 token」
 * （重试时用来认出「这个 token 原本是我们的，只是刚被换掉了」）。
 * 真正的缓存在注入的 {@link TokenCache} 里，跨进程共享。
 */
export class ComponentClient {
  readonly config: ComponentConfig
  private readonly http: HttpClient
  private readonly ticketStore: TicketStore
  private readonly cache: TokenCache
  private readonly marginSec: number
  private readonly now: Clock
  private readonly apiBase: string

  /** 同一时刻只允许一次刷新，否则并发请求会各发一次，微信那边后发的会让先发的失效 */
  // process-local: 并发去重只需要在本进程内生效，跨进程由 TokenCache 的共享值兜住
  private refreshing: Promise<string> | null = null

  /**
   * 上一个被换掉的 token。用来回答「URL 里这个 token 原本是不是我们的」——
   * 只比对「是不是当前那份」的话，被同伴刚换掉的那份会被误判成商家的 token 而放弃重试。
   */
  // process-local: 只是重试判据，丢了最多少一次自愈
  private previous: string | null = null

  constructor(options: ComponentClientOptions) {
    this.config = options.config
    this.http = options.http
    this.ticketStore = options.ticketStore
    this.cache = options.tokenCache
    this.marginSec = options.refreshMarginSec ?? DEFAULT_REFRESH_MARGIN_SEC
    this.now = options.now ?? Date.now
    this.apiBase = (options.apiBase ?? API_BASE).replace(/\/$/, '')
  }

  /** 这个 token 是不是平台自己的（当前那份，或刚被换掉的那份） */
  async wasMine(token: string): Promise<boolean> {
    if (token && token === this.previous) return true
    const current = await this.cache.get(componentTokenKey(this.config.appId))
    return Boolean(current && current.value === token)
  }

  /**
   * 平台级调用凭据。所有代商家的接口都要先拿到它。
   *
   * @param force `true` 时**丢掉缓存重新换一个**。用在拿到 40001 之后重试。
   */
  async getComponentAccessToken(force = false): Promise<string> {
    const key = componentTokenKey(this.config.appId)

    if (force) {
      // **已经有人在换了就搭他的车**。这一条最要紧：两个并发的强刷会互相拆台
      if (this.refreshing) return this.refreshing
      const current = await this.cache.get(key)
      this.previous = current?.value ?? this.previous
      await this.cache.del(key)
    } else {
      const cached = await this.cache.get(key)
      // 提前 marginSec 换新的：卡在最后一秒刷新，并发请求里会有几个用到刚过期的 token
      if (cached && cached.expiresAt - this.marginSec * 1000 > this.now()) return cached.value
      if (this.refreshing) return this.refreshing
    }

    this.refreshing ??= this.fetchComponentToken().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async fetchComponentToken(): Promise<string> {
    const ticket = await this.ticketStore.load(this.config.appId)
    if (!ticket) {
      throw wechatOpenError('TICKET_MISSING', {
        message:
          '尚未收到微信推送的 component_verify_ticket。' +
          '请确认开放平台后台的「授权事件接收 URL」已填好且能被公网访问；' +
          '刚配好的话最多等 10 分钟微信才会推第一次',
      })
    }
    const res = await this.post<{ component_access_token?: string; expires_in?: number }>(
      'api_component_token',
      {
        component_appsecret: this.config.appSecret,
        component_verify_ticket: ticket,
      },
      { withToken: false },
    )
    if (!res.component_access_token) {
      throw wechatOpenError('API_FAILED', {
        message: '获取 component_access_token 失败，请检查开放平台配置',
      })
    }
    const expiresIn = res.expires_in ?? 7200
    const token: CachedToken = {
      value: res.component_access_token,
      expiresAt: this.now() + expiresIn * 1000,
    }
    // 写进缓存时把 TTL 缩掉一截，让它比微信那边先过期——
    // 宁可多取一次，也不要拿着一个刚好失效的 token 去调接口
    await this.cache.set(
      componentTokenKey(this.config.appId),
      token,
      Math.max(60, expiresIn - this.marginSec),
    )
    return token.value
  }

  /**
   * 预授权码，用来拼商家扫码授权的地址。有效期 30 分钟、**一次性**。
   * 所以**不能缓存**：缓存下来第二个商家点进去就是一个已被用掉的码。
   */
  async preAuthCode(): Promise<string> {
    const res = await this.post<{ pre_auth_code?: string }>('api_create_preauthcode', {})
    if (!res.pre_auth_code) throw wechatOpenError('API_FAILED', { message: '获取预授权码失败' })
    return res.pre_auth_code
  }

  /**
   * 授权方的调用凭据：缓存命中就直接用，否则拿 refresh_token 换一份新的。
   *
   * @param onRefreshToken 微信**可能**下发一个新的 refresh_token，拿到就必须存——
   *   旧的会在若干次刷新后失效，届时表现是「用了很久突然全部失败」，
   *   而那时早已没人记得这里少写了一行。
   */
  async authorizerAccessToken(
    authorizerAppId: string,
    refreshToken: string,
    onRefreshToken?: (next: string) => Promise<void> | void,
  ): Promise<string> {
    const key = authorizerTokenKey(this.config.appId, authorizerAppId)
    const cached = await this.cache.get(key)
    if (cached && cached.expiresAt - this.marginSec * 1000 > this.now()) return cached.value

    const res: AuthorizerTokenResult = await refreshAuthorizerToken(this, {
      authorizerAppId,
      refreshToken,
    })
    if (res.refreshToken && res.refreshToken !== refreshToken) {
      await onRefreshToken?.(res.refreshToken)
    }

    await this.cache.set(
      key,
      { value: res.accessToken, expiresAt: this.now() + res.expiresIn * 1000 },
      Math.max(60, res.expiresIn - this.marginSec),
    )
    return res.accessToken
  }

  /** 换了凭据（重新授权 / 取消授权）就必须把缓存的那份丢掉 */
  async forgetAuthorizer(authorizerAppId: string): Promise<void> {
    await this.cache.del(authorizerTokenKey(this.config.appId, authorizerAppId))
  }

  /**
   * 统一的 POST 出口。
   *
   * 微信这套接口**永远回 HTTP 200**，成功失败都在 body 的 `errcode` 里——
   * 只看状态码等于把所有错误都当成功。
   *
   * `withToken` 缺省 true：除了换 component_access_token 本身，其余都要带上它。
   */
  async post<T>(
    path: string,
    body: Record<string, unknown>,
    opts: { withToken?: boolean } = {},
  ): Promise<T> {
    const qs =
      opts.withToken === false
        ? ''
        : `?component_access_token=${encodeURIComponent(await this.getComponentAccessToken())}`
    // `component_appid` 每个接口都要，统一在这里补：漏传时微信只回一句
    // 「invalid appid」，看不出是哪个字段没给
    const res = await this.http.post<T & WxResponse>(
      `${this.apiBase}/${path}${qs}`,
      { component_appid: this.config.appId, ...body },
      { 'Content-Type': 'application/json' },
    )

    if (res?.errcode) {
      if ((TOKEN_INVALID_ERRCODES as readonly number[]).includes(res.errcode)) {
        throw wechatOpenError('TOKEN_INVALID', {
          errcode: res.errcode,
          detail: `${path}: ${res.errmsg ?? ''}`,
        })
      }
      throw wechatOpenError('API_FAILED', {
        errcode: res.errcode,
        message: `微信开放平台调用失败（${res.errcode}）：${res.errmsg ?? ''}`,
        detail: path,
      })
    }
    return res
  }
}

/**
 * {@link TokenCache} 的内存实现。
 *
 * **只够单机与单测**。cluster 下每个进程各取一份 token，它们会互相把对方的作废，
 * 表现是接口间歇性报 40001。生产必须换成 Redis 实现（app 侧用 `@taizan/nest-infra`
 * 的 `CacheService` 适配，见 README）。
 */
export class MemoryTokenCache implements TokenCache {
  // process-local: 内存实现的定义就是进程内，生产用 Redis 实现替换
  private readonly rows = new Map<string, { token: CachedToken; expireAt: number }>()

  constructor(private readonly now: Clock = Date.now) {}

  async get(key: string): Promise<CachedToken | null> {
    const row = this.rows.get(key)
    if (!row) return null
    if (row.expireAt <= this.now()) {
      this.rows.delete(key)
      return null
    }
    return row.token
  }

  async set(key: string, token: CachedToken, ttlSec: number): Promise<void> {
    this.rows.set(key, { token, expireAt: this.now() + ttlSec * 1000 })
  }

  async del(key: string): Promise<void> {
    this.rows.delete(key)
  }
}
