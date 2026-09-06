import {
  ApiError,
  createEnvelopeClient,
  httpSemantic,
  type Transport,
  type TransportRequestOptions,
  type TransportResponse,
} from '@taizan/contracts'

/** 限流命中的那个码（`ErrorCode.TOO_MANY_REQUESTS`），见 `docs/ERROR-CODES.md`。 */
const TOO_MANY_REQUESTS_CODE = 1042900

/**
 * 四端统一响应包协议层（蓝图 §5.1）：`@taizan/contracts` 只导出一份 `createEnvelopeClient`，
 * 每一端各写一个 ≤40 行的 {@link Transport} 适配。官网只调三个公开接口、不带登录态，
 * 所以这份适配比 `apps/admin`/`apps/platform` 的 axios 版本还要薄——不需要 token、
 * 不需要 `X-Tenant-Slug`（注册这一刻租户还不存在）。
 */
const fetchTransport: Transport = {
  async request(opts: TransportRequestOptions): Promise<TransportResponse> {
    const query = opts.params
      ? '?' +
        new URLSearchParams(
          Object.entries(opts.params).filter(([, v]) => v !== undefined && v !== null) as [
            string,
            string,
          ][],
        ).toString()
      : ''
    const res = await fetch(opts.url + query, {
      method: opts.method,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key] = value
    })
    // 响应体不是合法 JSON（网关直接拦下、502 页面等）时留 `null`，
    // 交给 envelope-client 的 `classify()` 按 HTTP 状态码退化分流。
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, headers, body }
  },
}

/**
 * 官网没有登录态，三个钩子刻意留空：`onUnauthorized`/`onForbidden`/`onBizError`
 * 不做全局弹窗——公开接口的错误都是「这一次表单填得不对」，由调用方 `try/catch`
 * 拿到 {@link ApiError} 后就地在表单里显示，不该有一个全局 toast 抢戏。
 */
export const client = createEnvelopeClient(fetchTransport, {
  getToken: () => null,
  onUnauthorized: () => undefined,
  onForbidden: () => undefined,
  onBizError: () => undefined,
})

export { ApiError }

/**
 * 把一次失败的 {@link ApiError} 翻成给商家看的一句话。
 *
 * 只按 `httpSemantic(code)` 与业务码分流，不比对 `message` 字符串——后端文案改一个字
 * 这里不该跟着坏。`1042900`（限流命中）**必须**换成「稍后再试」而不是原样展示后端的
 * 「请求过于频繁」：那句话对着注册页最后一步的商家说，听起来像是他自己的操作有问题，
 * 而真实原因是这一档限流本身就很窄（同 IP/同手机号一天 3 次），不该让他去找自己的错。
 */
export function friendlyErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return '出错了，请稍后再试'
  if (error.code === TOO_MANY_REQUESTS_CODE || httpSemantic(error.code) === 429) {
    return '操作太频繁了，请稍后再试'
  }
  return error.message || '出错了，请稍后再试'
}

/** `GET /api/public/site-config` 里的一档在售套餐（价格现取自 `Plan` 表）。 */
export interface SitePlan {
  id: string
  code: string
  name: string
  firstPriceCents: number
  renewPriceCents: number
  periodMonths: number
  sort: number
}

/** `GET /api/public/site-config`。 */
export interface SiteConfig {
  signupEnabled: boolean
  trialDays: number
  plans: SitePlan[]
}

/** `GET /api/public/signup/check-slug`。 */
export interface CheckSlugResult {
  slug: string
  available: boolean
  reason: string | null
}

/** `POST /api/public/signup` 的请求体。 */
export interface SignupPayload {
  slug: string
  name: string
  phone: string
  password: string
  existingPassword?: string
  captchaId?: string
  captchaCode?: string
}

/** `POST /api/public/signup` 的回执（**不含 token**，见后端 TSDoc）。 */
export interface SignupResult {
  tenantId: string
  slug: string
  name: string
  trialEndAt: string
  trialDays: number
  accountCreated: boolean
  adminLoginPath: string
  message: string
}

/** 落地页要的站点配置。接口失败时按 §「兜底」处理——见 `Pricing.tsx`/`App.tsx` 的调用点。 */
export function fetchSiteConfig(): Promise<SiteConfig> {
  return client.get<SiteConfig>('/api/public/site-config')
}

/** slug 查重（`lookup` 档，边打字边查用它，不要用 `signup` 档）。 */
export function checkSlug(slug: string): Promise<CheckSlugResult> {
  return client.get<CheckSlugResult>('/api/public/signup/check-slug', { slug })
}

/** 出一张图形验证码。 */
export function fetchCaptcha(): Promise<{ id: string; svg: string }> {
  return client.get<{ id: string; svg: string }>('/api/public/signup/captcha')
}

/** 自助注册。 */
export function signup(payload: SignupPayload): Promise<SignupResult> {
  return client.post<SignupResult>('/api/public/signup', payload)
}

/** 分转元，四端约定金额一律为分，展示时才除以 100。 */
export function yuan(cents: number): string {
  return (cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}
