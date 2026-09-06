/**
 * 钛赞微信授权中转站（auth.taizan.vip）登录：PC 扫码 + 微信内 H5 网页授权。
 *
 * 中转站解决的是「一个公众号要接入多个服务」：微信给一个公众号只留了两个网页授权域名的名额，
 * 而且服务器配置只能填一份——商家的号已经在别的系统上用着，这两样都腾不出来给我们。
 * 中转站占掉其中一个名额，再把授权结果转给挂在它下面的每一个服务。商家在中转站建一个
 * 「接入项目」拿到 client_id / client_secret，填进我们这里就能登录，
 * **不必交出 AppSecret，也不必改公众号的任何配置**。
 *
 * **只做登录**。中转站不给 access_token（那是另一档套餐的能力），所以模板消息、分享签名
 * 照旧走授权接入 / 自填凭据——界面上要把这句话说出来（见 `canIssueAccessToken`）。
 *
 * 接口形状取自 `wx-relay-login` skill（拿真 client_id 实测，不是照文档猜的），
 * 错误码与文案搬自 knowledge `infra/wechat-relay/relay.rules.ts`。
 *
 * ## 服务端会话签发的安全规则（五条，每条对应一个真实事故面）
 *
 * 1. **`poll_token` 与 `scene` 只留在服务端**，前端只拿到我们自己发的 `sessionId`。
 *    只凭 poll_token 就能轮询的话，旁边拍到二维码的人就能顶掉这次登录。
 * 2. **ticket 一次性、60 秒过期，兑换失败不重试**——重试只会换回同一句 `TICKET_INVALID`，
 *    该做的是让用户重新发起登录。`CONFIRMED` 一到就立刻兑换，别攒着。
 * 3. **登录态是我方自己的**：拿到 openid 之后签本方服务端的 token（`@taizan/nest-auth`），
 *    之后与中转站无关。中转站只回答「这是谁」，从不签发我方的会话。
 * 4. **token 只交一次**：轮询返回终态时把 token 交出去，同时把会话删掉；同一 sessionId
 *    再问就是 `EXPIRED`。
 * 5. **中转站抖动（超时 / 5xx）当 `PENDING` 返回**，让前端下一轮再问，
 *    别把一次网络抖动报成登录失败。
 */

import { randomBytes } from 'node:crypto'
import { wechatOpenError } from './errors'
import type { Clock, HttpClient } from './types'

/** 中转站默认地址，私有化部署时覆盖 */
export const RELAY_DEFAULT_URL = 'https://auth.taizan.vip'

/**
 * H5 网页授权回跳落在这个路径上。**它要被商家填进中转站项目的回调白名单**，
 * 中转站只比对 pathname（query 随意）。改这个值等于让所有已接入商家的白名单集体失效——别改。
 */
export const RELAY_CALLBACK_PATH = '/auth/callback'

/** 中转站签发的 client_id 形状：`cli_` + 16 位十六进制 */
export const RELAY_CLIENT_ID_RE = /^cli_[0-9a-f]{16}$/

/** 扫码登录的四态。前端据此显示：等待 / 已扫待确认 / 完成 / 过期重来 */
export type RelayStatus = 'PENDING' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED'

/** 中转站原始状态串 → 四态。认不出的当 `PENDING`（下一轮再问），不当失败 */
export function toRelayStatus(raw: unknown): RelayStatus {
  switch (String(raw ?? '').toLowerCase()) {
    case 'scanned':
      return 'SCANNED'
    case 'confirmed':
      return 'CONFIRMED'
    case 'expired':
      return 'EXPIRED'
    default:
      return 'PENDING'
  }
}

/** 中转站认出来的微信身份。**只有身份，没有任何我方登录态** */
export interface RelayIdentity {
  openId: string
  /** 只有公众号绑了开放平台才有 */
  unionId: string | null
  /** scope 为 `snsapi_base` 时是 null */
  nickname: string | null
  avatar: string | null
}

/** 出码结果里服务端要留着的东西 */
export interface RelayQrSession {
  scene: string
  /** **只留服务端**，绝不下发前端 */
  pollToken: string
  /** 直接当 `<img src>`，是 `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=...` */
  qrUrl: string
  expiresIn: number
}

/** 一次轮询的结果 */
export interface RelayPollResult {
  status: RelayStatus
  /** 只有 `CONFIRMED` 才有，60 秒内必须兑换 */
  ticket: string | null
}

interface RelayError {
  error?: string
  message?: string
}

function base(url: string | undefined): string {
  return (url ?? RELAY_DEFAULT_URL).replace(/\/$/, '')
}

function raise(json: RelayError | null, fallbackDetail?: string): never {
  throw wechatOpenError('RELAY_FAILED', {
    errcode: json?.error ?? null,
    message: relayErrorMessage(json?.error, json?.message),
    detail: fallbackDetail,
  })
}

/**
 * 出码：`POST /oauth/qr/create`。
 *
 * `state` 是可选的：扫码这条路上中转站不回跳，state 没有防 CSRF 的作用，
 * 但把它带上便于两端日志对齐。真正防重放的是「poll_token 不下发」。
 */
export async function createRelaySession(input: {
  http: HttpClient
  clientId: string
  relayBaseUrl?: string
  state?: string
}): Promise<RelayQrSession> {
  const body: Record<string, unknown> = { client_id: input.clientId }
  if (input.state) body.state = input.state
  const res = await input.http.post<
    { scene?: string; poll_token?: string; qr_url?: string; expires_in?: number } & RelayError
  >(`${base(input.relayBaseUrl)}/oauth/qr/create`, body, { 'Content-Type': 'application/json' })

  if (res?.error || !res?.scene || !res?.poll_token || !res?.qr_url) {
    raise(res, '出码响应缺字段')
  }
  return {
    scene: res.scene,
    pollToken: res.poll_token,
    qrUrl: res.qr_url,
    expiresIn: res.expires_in ?? 300,
  }
}

/**
 * 轮询：`GET /oauth/qr/poll?scene=&poll_token=`。
 *
 * **中转站抖动一律当 `PENDING`**：网络错误、5xx、认不出的状态串，都让前端下一轮再问。
 * 把一次抖动报成失败，用户看到的是「二维码坏了」，而他其实已经扫过了。
 */
export async function pollRelay(input: {
  http: HttpClient
  scene: string
  pollToken: string
  relayBaseUrl?: string
}): Promise<RelayPollResult> {
  const url =
    `${base(input.relayBaseUrl)}/oauth/qr/poll` +
    `?scene=${encodeURIComponent(input.scene)}&poll_token=${encodeURIComponent(input.pollToken)}`
  let res: ({ status?: string; ticket?: string } & RelayError) | null = null
  try {
    res = await input.http.get<{ status?: string; ticket?: string } & RelayError>(url)
  } catch {
    return { status: 'PENDING', ticket: null }
  }
  // `BAD_POLL_TOKEN` 之外的错误也当抖动：这个接口每 2 秒打一次，
  // 把偶发错误变成终态的代价远大于多等 2 秒
  if (res?.error === 'BAD_POLL_TOKEN') return { status: 'EXPIRED', ticket: null }
  if (res?.error) return { status: 'PENDING', ticket: null }

  const status = toRelayStatus(res?.status)
  return { status, ticket: status === 'CONFIRMED' ? (res?.ticket ?? null) : null }
}

/**
 * 兑换身份：`POST /oauth/exchange`。ticket 一次性、60 秒过期，**失败不重试**。
 *
 * `client_secret` 只走这一个调用，**不进前端、不进 URL、不进日志**。
 */
export async function exchangeRelayCode(input: {
  http: HttpClient
  clientId: string
  clientSecret: string
  ticket: string
  relayBaseUrl?: string
}): Promise<RelayIdentity> {
  const res = await input.http.post<Record<string, unknown> & RelayError>(
    `${base(input.relayBaseUrl)}/oauth/exchange`,
    { client_id: input.clientId, client_secret: input.clientSecret, ticket: input.ticket },
    { 'Content-Type': 'application/json' },
  )
  if (res?.error) raise(res)
  const identity = parseRelayExchange(res)
  if (!identity) {
    throw wechatOpenError('RELAY_FAILED', {
      message: '中转站没有返回微信身份，请重新发起登录',
      detail: '响应里没有 openid',
    })
  }
  return identity
}

/**
 * 整理 `/oauth/exchange` 的响应。
 *
 * `user` 在 scope 为 `snsapi_base` 时是 null，`unionid` 只有公众号绑了开放平台才有——
 * 两者缺了都不是错，**openid 缺了才是**。
 */
export function parseRelayExchange(json: unknown): RelayIdentity | null {
  const d = (json ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const openId = str(d.openid)
  if (!openId) return null
  const user = (d.user && typeof d.user === 'object' ? d.user : {}) as Record<string, unknown>
  return {
    openId,
    unionId: str(d.unionid),
    nickname: str(user.nickname),
    avatar: str(user.headimgurl),
  }
}

/** 要填进中转站白名单的完整回调地址（H5 那条路用） */
export function relayCallbackUrl(h5Base: string): string {
  return `${h5Base.replace(/\/$/, '')}${RELAY_CALLBACK_PATH}`
}

/**
 * 微信内 H5 网页授权的发起地址：`GET /oauth/start`。
 *
 * `redirect_uri` 必须已经在商家的中转站白名单里。**它的 host 同样只能用当前请求的 Host 重建**
 * （用 `buildOAuthUrl` 同一套 `safeHost` / `safeRedirectPath`，见 `oauth-state.ts`），
 * 这里只负责把算好的地址搬到中转站要求的固定 pathname 上。
 *
 * 必须在微信客户端内打开，普通浏览器会报 10003——PC 端只能扫码。
 */
export function buildRelayStartUrl(input: {
  relayBaseUrl?: string
  clientId: string
  /** 已经过 host 重建的安全回跳地址 */
  redirectUri: string
  state: string
  scope?: 'snsapi_base' | 'snsapi_userinfo'
}): string {
  const u = new URL(input.redirectUri)
  u.pathname = RELAY_CALLBACK_PATH
  u.hash = ''
  const q = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: u.toString(),
    scope: input.scope ?? 'snsapi_userinfo',
    state: input.state,
  })
  return `${base(input.relayBaseUrl)}/oauth/start?${q.toString()}`
}

/**
 * 中转站的错误码翻成商家 / 学员看得懂的话，并指出**该由谁去做什么**。
 *
 * 学员在登录那一刻看到的就是这句，所以不能只回一个英文码；但也不能把所有失败都说成
 * 「请重新扫码」——配额用完、套餐到期、回调地址没配都是商家那边的事，
 * 学员重扫一百次也没用，要让他知道去找商家。
 */
export function relayErrorMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case 'TICKET_INVALID':
      return '登录凭证已失效，请重新发起微信登录'
    case 'BAD_POLL_TOKEN':
      return '这次扫码会话已失效，请刷新二维码重来'
    case 'UNKNOWN_CLIENT':
      return '本店的中转站接入项目不存在或已被删除，请联系商家在「渠道 → 公众号」重新填写'
    case 'INVALID_CLIENT_SECRET':
      return '本店的中转站 client_secret 不正确，请联系商家在「渠道 → 公众号」重新填写'
    case 'NO_REDIRECT_URI':
    case 'REDIRECT_URI_NOT_ALLOWED':
      return '本店的中转站项目还没把登录回调地址加入白名单，请联系商家在中转站控制台补上'
    case 'IP_NOT_ALLOWED':
      return '中转站项目设置了 IP 白名单但没包含本平台的出口 IP，请联系商家在中转站控制台调整'
    case 'SCOPE_NOT_ALLOWED':
      return '本店的中转站项目没有开放「获取昵称头像」的授权范围（snsapi_userinfo），请联系商家在中转站控制台勾上'
    case 'QUOTA_EXCEEDED':
      return '本店在中转站的本月授权次数已用完，请联系商家升级中转站套餐'
    case 'TENANT_EXPIRED':
      return '本店的中转站套餐已到期，请联系商家续费'
    case 'STATE_EXPIRED':
      return '登录超时，请重新发起微信登录'
    case 'ACCESS_DENIED':
      return '你取消了微信授权'
    default:
      return fallback ? `中转站登录失败：${fallback}` : '中转站登录失败，请稍后重试'
  }
}

/** 服务端会话：`sessionId` 是我方发的，`scene`/`pollToken` 只在这里 */
export interface RelayLoginSession extends RelayQrSession {
  sessionId: string
  expireAt: number
}

/** 会话存储。生产用 Redis / 库表，键就是我方发的 sessionId */
export interface RelaySessionStore {
  put(session: RelayLoginSession): Promise<void>
  get(sessionId: string): Promise<RelayLoginSession | null>
  del(sessionId: string): Promise<void>
}

/** {@link RelaySessionStore} 的内存实现，只够单机与单测 */
export class MemoryRelaySessionStore implements RelaySessionStore {
  // process-local: 内存实现的定义就是进程内，生产用 Redis 实现替换
  private readonly rows = new Map<string, RelayLoginSession>()

  constructor(private readonly now: Clock = Date.now) {}

  async put(session: RelayLoginSession): Promise<void> {
    this.rows.set(session.sessionId, session)
  }

  async get(sessionId: string): Promise<RelayLoginSession | null> {
    const row = this.rows.get(sessionId)
    if (!row) return null
    if (row.expireAt <= this.now()) {
      this.rows.delete(sessionId)
      return null
    }
    return row
  }

  async del(sessionId: string): Promise<void> {
    this.rows.delete(sessionId)
  }
}

export interface RelayLoginClientOptions {
  http: HttpClient
  clientId: string
  /** **只在服务端**。由 app 侧用 `@taizan/crypto` 的 vault 解密后传入 */
  clientSecret: string
  relayBaseUrl?: string
  sessions?: RelaySessionStore
  now?: Clock
  /** 随机源注入口，只为测试可复现 */
  random?: (size: number) => Buffer
}

/**
 * PC 扫码登录的服务端编排：出码 → 轮询 → 兑换身份。
 *
 * 前端只看得到 `sessionId` 与 `qrUrl`；`scene` 与 `pollToken` 一步都不下发。
 * **本类不签发任何登录态**——它只把 {@link RelayIdentity} 交出来，
 * 签 token、建用户、给新用户初始化，都由 app 侧在拿到身份之后做。
 */
export class RelayLoginClient {
  private readonly opts: RelayLoginClientOptions
  private readonly sessions: RelaySessionStore
  private readonly now: Clock
  private readonly random: (size: number) => Buffer

  constructor(options: RelayLoginClientOptions) {
    this.opts = options
    this.now = options.now ?? Date.now
    this.sessions = options.sessions ?? new MemoryRelaySessionStore(this.now)
    this.random = options.random ?? randomBytes
  }

  /** 新建一次扫码登录会话。返回的东西可以直接下发前端 */
  async createRelaySession(input: { state?: string } = {}): Promise<{
    sessionId: string
    qrUrl: string
    expiresIn: number
  }> {
    const qr = await createRelaySession({
      http: this.opts.http,
      clientId: this.opts.clientId,
      relayBaseUrl: this.opts.relayBaseUrl,
      state: input.state,
    })
    const sessionId = this.random(24).toString('base64url')
    await this.sessions.put({
      ...qr,
      sessionId,
      expireAt: this.now() + qr.expiresIn * 1000,
    })
    return { sessionId, qrUrl: qr.qrUrl, expiresIn: qr.expiresIn }
  }

  /**
   * 轮询一次。
   *
   * 本地没这行或本地已过期 → 直接 `EXPIRED`，**不去问中转站**：
   * 会话是我方发的，我方说没有就是没有。
   *
   * `CONFIRMED` 时**立刻兑换**并把会话删掉（规矩 2 与 4）：ticket 只有 60 秒，
   * 攒到下一轮就已经过期了。兑换失败一样删会话——重试只会换回同一句 `TICKET_INVALID`。
   */
  async pollRelay(
    sessionId: string,
  ): Promise<
    | { status: 'PENDING' | 'SCANNED' | 'EXPIRED'; identity?: undefined; note?: string }
    | { status: 'CONFIRMED'; identity: RelayIdentity; note?: undefined }
  > {
    const session = await this.sessions.get(sessionId)
    if (!session) return { status: 'EXPIRED' }

    const res = await pollRelay({
      http: this.opts.http,
      scene: session.scene,
      pollToken: session.pollToken,
      relayBaseUrl: this.opts.relayBaseUrl,
    })
    if (res.status === 'EXPIRED') {
      await this.sessions.del(sessionId)
      return { status: 'EXPIRED' }
    }
    // CONFIRMED 却没带 ticket 是中转站的中间态，当 PENDING 让前端下一轮再问
    if (res.status !== 'CONFIRMED' || !res.ticket) {
      return { status: res.status === 'CONFIRMED' ? 'PENDING' : res.status }
    }

    // token 只交一次：先删会话再兑换，同一 sessionId 再问就是 EXPIRED
    await this.sessions.del(sessionId)
    try {
      const identity = await this.exchangeRelayCode(res.ticket)
      return { status: 'CONFIRMED', identity }
    } catch (e) {
      return { status: 'EXPIRED', note: e instanceof Error ? e.message : '兑换失败，请重新扫码' }
    }
  }

  /** 拿 ticket 换微信身份。单独暴露是给 H5 那条路（回跳带回 ticket）复用 */
  async exchangeRelayCode(ticket: string): Promise<RelayIdentity> {
    return exchangeRelayCode({
      http: this.opts.http,
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      ticket,
      relayBaseUrl: this.opts.relayBaseUrl,
    })
  }
}
