import {
  createEnvelopeClient,
  ErrorCode,
  type ApiError,
  type EnvelopeClient,
} from '@taizan/contracts'
import { createAxiosTransport } from './axios-transport'

/** {@link createRequest} 的入参：把蓝图 §4.9 的错误码语义翻译成回调，业务侧只管接哪个钩子。 */
export interface CreateRequestOptions {
  /** 接口前缀，如 `/api` */
  baseURL: string
  /** 取当前登录态 token；返回 `null` 表示未登录 */
  getToken: () => string | null
  /** 取当前租户 slug（一号多店场景下用于 `X-Tenant-Slug` 头） */
  getTenantSlug?: () => string | null
  /** `httpSemantic(code) === 401`：清态跳登录 */
  onUnauthorized: (error: ApiError) => void
  /** `httpSemantic(code) === 403` 且不是套餐到期只读码：只提示不登出 */
  onForbidden: (error: ApiError) => void
  /** 其余业务错误码（400/404/429/500 及业务自定义段） */
  onBizError: (error: ApiError) => void
  /**
   * 码值恰好是 `1440301`（套餐到期只读，见 `ErrorCode.PLAN_READONLY`）时触发，
   * 不会再重复触发 `onForbidden`——蓝图 §4.9 要求这个码单独弹「去续费」并跳账单页，
   * 和普通「无权限」的提示分开，否则商家只会来问客服。
   */
  onReadonly: (error: ApiError) => void
}

/**
 * 基于 axios 创建信封客户端（蓝图 §5.1/§T3-1）。
 *
 * 只是把 {@link createAxiosTransport} 与 `@taizan/contracts` 的 `createEnvelopeClient`
 * 接起来，并把 `1440301` 从 `onForbidden` 里单独摘出来分流到 `onReadonly`——
 * 这是四端协议层之上、admin-ui 这一端独有的一点点分流逻辑。
 */
export function createRequest(opts: CreateRequestOptions): EnvelopeClient {
  const transport = createAxiosTransport(opts.baseURL)
  return createEnvelopeClient(transport, {
    getToken: opts.getToken,
    getTenantSlug: opts.getTenantSlug,
    onUnauthorized: opts.onUnauthorized,
    onForbidden: (error) => {
      if (error.code === ErrorCode.PLAN_READONLY.code) {
        opts.onReadonly(error)
        return
      }
      opts.onForbidden(error)
    },
    onBizError: opts.onBizError,
  })
}

/** 把 `ApiError` 拼成一条带 traceId 的提示文案，方便报障时回传给客服/日志排查。 */
export function describeApiError(error: ApiError): string {
  return error.traceId ? `${error.message}（追踪ID：${error.traceId}）` : error.message
}
