/**
 * `/api/public/invites/:token` 的前端客户端（T1-9 落地页）。
 *
 * ## 为什么不复用 `useSession().request`
 *
 * 这一屏免登录（`RequireAuth` 之外），而 `createSessionStore()` 把
 * `httpSemantic(code) === 401` 的错误码接到了 `onUnauthorized`：清 token、
 * 整页跳 `/login`。核销邀请时手机号已有账号但密码填错，后端回的正是
 * `ErrorCode.UNAUTHENTICATED`（`1140100`，「手机号或密码不正确」，与登录接口同一套
 * 文案是故意的，见 `invite.service.ts`）——如果这里用 `useSession().request`，
 * 填错密码不会看到错误提示，而是被立刻甩到登录页，邀请落地页的状态全部丢失。
 *
 * 所以这里直接用 `fetch` 拼一个最小的信封客户端：剥包、把非 0 码包成
 * {@link InviteApiError} 抛出，仅此而已，不接错误码分流。
 */

const BASE_URL = import.meta.env.VITE_API_BASE || ''

/** 信封响应体的形状（`@taizan/contracts` 的 `ApiResponse`），这里不引整个包，自己镜像一份。 */
interface Envelope<T> {
  code: number
  message: string
  data: T
}

/** 邀请核销接口的业务错误：携带信封 `code`，供页面按码分流提示文案。 */
export class InviteApiError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'InviteApiError'
    this.code = code
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const envelope = (await res.json()) as Partial<Envelope<T>>
  if (typeof envelope.code !== 'number' || envelope.code !== 0) {
    throw new InviteApiError(envelope.code ?? res.status, envelope.message ?? `HTTP ${res.status}`)
  }
  return envelope.data as T
}

/** `GET /api/public/invites/:token` 的响应。 */
export interface InviteLookupResult {
  valid: boolean
  /** 无效时的原因：`NOT_FOUND` / `USED` / `EXPIRED` / `SHOP_UNAVAILABLE`。 */
  reason: string | null
  shopName: string | null
  /** 限定手机号，打码后的（`138****0005`）；不限手机号时是 `null`。 */
  phoneMask: string | null
  expiresAt: string | null
}

export interface AcceptInviteInput {
  phone: string
  /** 手机号已有账号时必须是它现有的登录密码；没有账号时是新账号的初始密码。 */
  password: string
}

/** `POST /api/public/invites/:token/accept` 的响应。刻意不含 token——接受后请跳登录页。 */
export interface AcceptInviteResult {
  tenantId: string
  tenantSlug: string
  tenantName: string
  staffId: string
  loggedIn: false
}

export function useInviteApi() {
  return {
    lookup: (token: string) => call<InviteLookupResult>('GET', `/api/public/invites/${token}`),
    accept: (token: string, values: AcceptInviteInput) =>
      call<AcceptInviteResult>('POST', `/api/public/invites/${token}/accept`, values),
  }
}
