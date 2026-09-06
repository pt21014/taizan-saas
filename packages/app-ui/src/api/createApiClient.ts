import {
  ErrorCode,
  createEnvelopeClient,
  type ApiError,
  type EnvelopeClient,
} from '@taizan/contracts'

import { createFetchTransport } from './transport'

/** {@link createApiClient} 的行为钩子——都是「怎么响应」，不是「怎么请求」。 */
export interface ApiClientHooks {
  /** 取当前登录态 token；由调用方的 session 层持有，这里只读不写。 */
  getToken(): string | null
  /** 取当前租户 slug（学员端用；商家端 staff token 自带 tenantId，不必给）。 */
  getTenantSlug?(): string | null
  /** `401`：调用方负责清 SecureStore 会话并跳登录页——导航能力只有 App 自己有。 */
  onUnauthorized(error: ApiError): void
  /** `1440302` 店铺打烊：这是唯一一个从「无权限」里单独摘出来路由到打烊页的码。 */
  onShopClosed(reason: string): void
  /** 其余 `403`（不是打烊）：只提示，不登出。 */
  onForbidden?(message: string): void
  /** 其他业务/传输错误：`message` 已经把 `X-Trace-Id` 拼进去，方便报障。 */
  onBizError?(message: string, traceId: string | null): void
}

/** 响应头 `X-Trace-Id` 回显进错误提示，方便用户报障时把这串号回传给客服。 */
export function formatWithTrace(error: ApiError): string {
  return error.traceId ? `${error.message}（追踪号：${error.traceId}）` : error.message
}

/**
 * `@taizan/app-ui` 的 API 客户端（蓝图 §5.1/§5.4）：在 `createEnvelopeClient` 之上，
 * 把「`403` 里哪个码是打烊、哪个只是普通无权限」这一层分流也做掉，两个 App 不用各判一遍。
 */
export function createApiClient(baseUrl: string, hooks: ApiClientHooks): EnvelopeClient {
  const transport = createFetchTransport(baseUrl)
  return createEnvelopeClient(transport, {
    getToken: hooks.getToken,
    getTenantSlug: hooks.getTenantSlug,
    onUnauthorized: hooks.onUnauthorized,
    onForbidden: (error) => {
      if (error.code === ErrorCode.SHOP_CLOSED.code) {
        hooks.onShopClosed(error.message)
        return
      }
      hooks.onForbidden?.(formatWithTrace(error))
    },
    onBizError: (error) => hooks.onBizError?.(formatWithTrace(error), error.traceId),
  })
}
