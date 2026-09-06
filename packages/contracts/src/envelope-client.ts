import { httpSemantic } from './error-codes'
import { SUCCESS_CODE, type ApiResponse } from './response'

/**
 * 四端统一的响应包协议层（蓝图 §5.1）：`@taizan/contracts` 导出一份协议实现，
 * 四端（axios / fetch / `Taro.request` / RN fetch）各自只需实现一个 ≤40 行的 {@link Transport}
 * 适配，剥包、错误码分流、租户头注入、traceId 回显这些逻辑只在这里写一遍。
 */

/**
 * HTTP 方法（信封客户端关心的几种）。
 *
 * `PATCH` 是后来补的（T3-4）：本框架大量「操作」类接口（冻结/续期/改套餐/上下架/
 * 启停……）后端一律用 `@Patch` 声明，PUT 打不进只注册了 `@Patch` 的路由（Nest 按方法
 * 精确匹配，是 404 不是「顺便也通」）。补之前各端只能各自借 `raw()` 绕一次
 * （见 `apps/platform/src/api/patch.ts` 的历史注释），现在四端都能直接用 `patch()`。
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** 传给 {@link Transport.request} 的请求描述。 */
export interface TransportRequestOptions {
  method: HttpMethod
  url: string
  /** query 参数（GET/DELETE 常用） */
  params?: Record<string, unknown>
  /** 请求体（POST/PUT 常用） */
  body?: unknown
  /** 请求头；`createEnvelopeClient` 会在此基础上补充 `Authorization`/`X-Tenant-Slug` */
  headers?: Record<string, string>
}

/** {@link Transport.request} 的返回结果。 */
export interface TransportResponse {
  /** HTTP 状态码 */
  status: number
  /** 响应头；key 建议已归一化为小写或原样透传，本模块两种大小写都会尝试读取 `X-Trace-Id` */
  headers: Record<string, string>
  /** 响应体；正常情况下应是 `ApiResponse` 形状，异常传输失败时可能是任意值甚至 `undefined` */
  body: unknown
}

/**
 * 传输适配接口。四端各实现一个：axios 拦截器、`fetch`、`Taro.request`、RN `fetch`。
 * 这一层只负责「发出 HTTP 请求、原样返回状态码/响应头/响应体」，
 * 不做任何剥包/错误处理——那是 `createEnvelopeClient` 的职责。
 */
export interface Transport {
  request(opts: TransportRequestOptions): Promise<TransportResponse>
}

/**
 * 业务/传输层错误的统一异常类型。`createEnvelopeClient` 在非成功响应时会用它 `reject`。
 */
export class ApiError extends Error {
  /** 业务错误码（见 `error-codes.ts`）；无法解析出信封时退化为 HTTP 状态码 */
  readonly code: number
  /** 响应头 `X-Trace-Id`，方便用户报障时回传给客服/日志排查 */
  readonly traceId: string | null

  constructor(code: number, message: string, traceId: string | null) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.traceId = traceId
  }
}

/** {@link createEnvelopeClient} 的行为钩子。 */
export interface EnvelopeHooks {
  /** 取当前登录态 token；返回 `null` 表示未登录，不加 `Authorization` 头 */
  getToken(): string | null
  /** `httpSemantic(code) === 401` 时触发：清态跳登录 */
  onUnauthorized(error: ApiError): void
  /** `httpSemantic(code) === 403` 时触发：只提示不登出 */
  onForbidden(error: ApiError): void
  /** 其他非成功码（400/404/429/500 及业务自定义段）时触发 */
  onBizError(error: ApiError): void
  /** 取当前租户 slug；返回非空字符串时会加 `X-Tenant-Slug` 头 */
  getTenantSlug?(): string | null
}

/** {@link createEnvelopeClient} 返回的客户端。 */
export interface EnvelopeClient {
  get<T>(url: string, params?: Record<string, unknown>): Promise<T>
  post<T>(url: string, body?: unknown): Promise<T>
  put<T>(url: string, body?: unknown): Promise<T>
  /** 与 `put()` 同形（剥包只返回 `data`），发的是 `PATCH` 请求。 */
  patch<T>(url: string, body?: unknown): Promise<T>
  delete<T>(url: string, params?: Record<string, unknown>): Promise<T>
  /** 拿完整信封（不剥 `data`），用于需要读 `code`/`message` 本身的场景 */
  raw<T>(opts: TransportRequestOptions): Promise<ApiResponse<T>>
}

function readTraceId(headers: Record<string, string>): string | null {
  return headers['X-Trace-Id'] ?? headers['x-trace-id'] ?? null
}

/** 把 body 是否符合信封形状，与用于分流的 HTTP 语义一起解析出来。 */
function classify(res: TransportResponse): { envelope: ApiResponse<unknown>; semantic: number } {
  const body = res.body as Partial<ApiResponse<unknown>> | null | undefined
  if (body && typeof body === 'object' && typeof body.code === 'number') {
    const envelope: ApiResponse<unknown> = {
      code: body.code,
      message: typeof body.message === 'string' ? body.message : '',
      data: (body.data ?? null) as unknown,
    }
    return { envelope, semantic: httpSemantic(body.code) }
  }
  // 极端情况：响应体不是信封形状（网关直接拦下、代理层报错等）。
  // 退化为用 HTTP 状态码本身作为分流依据，而不是硬套 httpSemantic() 公式误算出一个无意义的值。
  return {
    envelope: { code: res.status, message: `HTTP ${res.status}`, data: null },
    semantic: res.status,
  }
}

/**
 * 基于一个 {@link Transport} 创建信封客户端。
 *
 * 行为：
 * - 每次请求自动附加 `Authorization: Bearer <token>`（当 `getToken()` 非空）与
 *   `X-Tenant-Slug`（当 `getTenantSlug()` 非空）；
 * - 响应非 2xx 或信封 `code !== 0` 时，按 `httpSemantic(code)` 分流到
 *   `onUnauthorized`/`onForbidden`/`onBizError`，并 `reject` 一个 {@link ApiError}
 *   （携带 `code`、`message`、来自响应头 `X-Trace-Id` 的 `traceId`）；
 * - `get`/`post`/`put`/`delete` 剥包只返回 `data`；`raw` 返回完整信封（成功时）。
 */
export function createEnvelopeClient(transport: Transport, hooks: EnvelopeHooks): EnvelopeClient {
  async function raw<T>(opts: TransportRequestOptions): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...opts.headers }
    const token = hooks.getToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    const slug = hooks.getTenantSlug?.()
    if (slug) {
      headers['X-Tenant-Slug'] = slug
    }

    const res = await transport.request({ ...opts, headers })
    const { envelope, semantic } = classify(res)

    if (envelope.code === SUCCESS_CODE) {
      return envelope as ApiResponse<T>
    }

    const traceId = readTraceId(res.headers)
    const error = new ApiError(envelope.code, envelope.message, traceId)
    if (semantic === 401) {
      hooks.onUnauthorized(error)
    } else if (semantic === 403) {
      hooks.onForbidden(error)
    } else {
      hooks.onBizError(error)
    }
    throw error
  }

  return {
    raw,
    async get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
      const res = await raw<T>({ method: 'GET', url, params })
      return res.data
    },
    async post<T>(url: string, body?: unknown): Promise<T> {
      const res = await raw<T>({ method: 'POST', url, body })
      return res.data
    },
    async put<T>(url: string, body?: unknown): Promise<T> {
      const res = await raw<T>({ method: 'PUT', url, body })
      return res.data
    },
    async patch<T>(url: string, body?: unknown): Promise<T> {
      const res = await raw<T>({ method: 'PATCH', url, body })
      return res.data
    },
    async delete<T>(url: string, params?: Record<string, unknown>): Promise<T> {
      const res = await raw<T>({ method: 'DELETE', url, params })
      return res.data
    },
  }
}
