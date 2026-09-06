/**
 * 测试桩：假中转站与假微信开放平台。
 *
 * 随包发布（不是只放在 spec 里），因为 app 侧接线时也要用同一份：
 * 各写一个假服务端的话，两边对接口形状的理解会分叉，而分叉的那一刻两边测试都是绿的。
 */

import type { HttpClient } from './types'

/** 假中转站的三个端点，`any` 表示不挑端点 */
export type FakeRelayEndpoint = 'any' | 'create' | 'poll' | 'exchange'

/** 一次被记录下来的请求，断言「有没有发出去、发了几次」用 */
export interface RecordedCall {
  method: 'GET' | 'POST'
  url: string
  body?: unknown
}

/**
 * 假中转站。四态与几种错误都能造。
 *
 * 用法：
 * ```ts
 * const relay = new FakeRelayServer()
 * const client = new RelayLoginClient({ http: relay, clientId: 'cli_0123456789abcdef', clientSecret: 's' })
 * const { sessionId } = await client.createRelaySession()
 * relay.scan()      // → SCANNED
 * relay.confirm()   // → CONFIRMED，下一次 poll 会立刻兑换
 * ```
 */
export class FakeRelayServer implements HttpClient {
  /** 收到的每一次调用 */
  readonly calls: RecordedCall[] = []

  /** 当前二维码的状态 */
  status: 'pending' | 'scanned' | 'confirmed' | 'expired' = 'pending'
  /** 下一次 poll 抛异常（模拟中转站抖动） */
  flaky = false
  /** 下一次调用要回的错误码（可指定只对某个端点生效），回一次就清掉 */
  private nextError: { error: string; on: FakeRelayEndpoint } | null = null
  /** 兑换成功时回的身份 */
  identity: Record<string, unknown> = {
    openid: 'o_fake_openid',
    unionid: 'u_fake_unionid',
    scope: 'snsapi_userinfo',
    user: { nickname: '钛赞测试', headimgurl: 'https://example.test/a.png' },
  }

  private ticket = 'tk_fake_ticket'
  private issued = 0

  /** 有人扫了 */
  scan(): void {
    this.status = 'scanned'
  }

  /** 在微信里点了确认 */
  confirm(ticket = 'tk_fake_ticket'): void {
    this.status = 'confirmed'
    this.ticket = ticket
  }

  /** 二维码过期 */
  expire(): void {
    this.status = 'expired'
  }

  /**
   * 让下一次调用回一个错误码。
   *
   * `on` 指定只对某个端点生效——不指定的话，「让兑换失败」会先被中间那次轮询吃掉，
   * 而测试里看到的是「一直 PENDING」，与想测的东西完全无关。
   */
  failNext(error: string, on: FakeRelayEndpoint = 'any'): void {
    this.nextError = { error, on }
  }

  /** 出过几次码 */
  get issuedCount(): number {
    return this.issued
  }

  async get<T = unknown>(url: string): Promise<T> {
    this.calls.push({ method: 'GET', url })
    if (!url.includes('/oauth/qr/poll')) throw new Error(`假中转站不认识这个 GET：${url}`)
    if (this.flaky) throw new Error('ECONNRESET')
    const err = this.takeError('poll')
    if (err) return { error: err, message: '假中转站造的错误' } as T
    const body: Record<string, unknown> = { status: this.status }
    if (this.status === 'confirmed') body.ticket = this.ticket
    return body as T
  }

  async post<T = unknown>(url: string, body?: unknown): Promise<T> {
    this.calls.push({ method: 'POST', url, body })
    const kind: FakeRelayEndpoint = url.includes('/oauth/exchange') ? 'exchange' : 'create'
    const err = this.takeError(kind)
    if (err) return { error: err, message: '假中转站造的错误' } as T

    if (url.includes('/oauth/qr/create')) {
      this.issued += 1
      this.status = 'pending'
      return {
        scene: `scene_${this.issued}`,
        poll_token: `pt_${this.issued}`,
        qr_url: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=qr_${this.issued}`,
        expires_in: 300,
      } as T
    }
    if (url.includes('/oauth/exchange')) {
      const sent = (body ?? {}) as Record<string, unknown>
      // ticket 一次性：同一个 ticket 兑换第二次一律 TICKET_INVALID
      if (sent.ticket !== this.ticket) {
        return { error: 'TICKET_INVALID', message: 'ticket 无效或已用过' } as T
      }
      this.ticket = `used_${this.ticket}`
      return this.identity as T
    }
    throw new Error(`假中转站不认识这个 POST：${url}`)
  }

  private takeError(kind: FakeRelayEndpoint): string | null {
    const e = this.nextError
    if (!e) return null
    if (e.on !== 'any' && e.on !== kind) return null
    this.nextError = null
    return e.error
  }
}

/**
 * 假微信开放平台。按「path → 依次返回的响应」排队，用完最后一个就一直返回它。
 *
 * 排队而不是固定返回，是为了能测「第一次回 40001、第二次回新 token」这类自愈路径。
 */
export class FakeWechatOpenServer implements HttpClient {
  readonly calls: RecordedCall[] = []
  private readonly queues = new Map<string, unknown[]>()

  /** 给某个 path（如 `api_component_token`）排队几个响应 */
  on(path: string, ...responses: unknown[]): this {
    const q = this.queues.get(path) ?? []
    q.push(...responses)
    this.queues.set(path, q)
    return this
  }

  /** 某个 path 被调了几次 */
  countOf(path: string): number {
    return this.calls.filter((c) => c.url.includes(path)).length
  }

  async get<T = unknown>(url: string): Promise<T> {
    this.calls.push({ method: 'GET', url })
    return this.take<T>(url)
  }

  async post<T = unknown>(url: string, body?: unknown): Promise<T> {
    this.calls.push({ method: 'POST', url, body })
    return this.take<T>(url)
  }

  private take<T>(url: string): T {
    for (const [path, queue] of this.queues) {
      if (!url.includes(path)) continue
      if (queue.length === 0) break
      const next = queue.length === 1 ? queue[0] : queue.shift()
      return next as T
    }
    throw new Error(`假开放平台没有为这个地址准备响应：${url}`)
  }
}
