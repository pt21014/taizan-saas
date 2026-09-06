/**
 * 蓝图 §5.1：四端统一的响应包协议层由 `@taizan/contracts` 的 `createEnvelopeClient`
 * 提供**唯一一份**实现，Taro 侧只需要写一个 `Transport` 适配（{@link createTaroTransport}，
 * ≤40 行）+ 一层 C 端专用的错误码分流（{@link createClientRequest}）。
 *
 * C 端比 admin/platform 多两个专属分支：
 * - `1440302`（`ErrorCode.SHOP_CLOSED`）：套餐到期打烊，整页换成打烊页，不是弹个 toast；
 * - `1240400`（`ErrorCode.TENANT_NOT_FOUND`）：slug 解析不出店铺/店铺不存在，整页换成
 *   店铺不可用页。
 *
 * 这两个码在 `httpSemantic()` 下分别落在 403 与 404 语义里，`createEnvelopeClient` 本身
 * 只会把它们分流到 `onForbidden`/`onBizError`——具体是不是这两个特殊码，由本文件在
 * 钩子内部再判一层 `error.code`。
 *
 * @packageDocumentation
 */

import type { ApiError, EnvelopeClient, Transport, TransportResponse } from '@taizan/contracts'
import { createEnvelopeClient, ErrorCode } from '@taizan/contracts'
import Taro from '@tarojs/taro'

/**
 * 基于 `Taro.request` 的传输适配（蓝图 §5.1 要求的「≤40 行」那一份）。
 *
 * 只负责发请求、把 `Taro.request` 的返回值整形成 {@link TransportResponse}；
 * 剥包、错误分流一律不在这里做——那是 `createEnvelopeClient` 的职责。
 */
export function createTaroTransport(): Transport {
  return {
    async request(opts): Promise<TransportResponse> {
      const isQueryMethod = opts.method === 'GET' || opts.method === 'DELETE'
      const res = await Taro.request({
        url: opts.url,
        method: opts.method,
        data: (isQueryMethod ? opts.params : opts.body) as Record<string, unknown> | undefined,
        header: opts.headers,
      })
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(res.header ?? {})) {
        headers[key] = String(value)
      }
      return { status: res.statusCode, headers, body: res.data }
    },
  }
}

/** {@link createClientRequest} 的入参：baseURL + 四端共用的会话/租户/闸门钩子。 */
export interface ClientRequestOptions {
  /** API 基地址，来自 env（`TARO_APP_API_BASE`），禁止在包内写死域名 */
  baseURL: string
  /** 取当前 member token；未登录返回 `null` */
  getToken(): string | null
  /** 取当前 tenantSlug（见 `tenant.ts`）；未解析出来返回 `null` */
  getTenantSlug(): string | null
  /** `httpSemantic===401`：清态跳登录 */
  onUnauthorized?(error: ApiError): void
  /** `1440302`（`ErrorCode.SHOP_CLOSED`）：套餐到期打烊，整页跳打烊页 */
  onClosed?(error: ApiError): void
  /** `1240400`（`ErrorCode.TENANT_NOT_FOUND`）：slug 解析不出店铺，整页跳店铺不可用页 */
  onTenantMissing?(error: ApiError): void
  /** 除 `onClosed` 命中之外的其余 403：只提示不清态 */
  onForbidden?(error: ApiError): void
  /** 除 `onUnauthorized`/`onClosed`/`onTenantMissing` 命中之外的其余错误 */
  onBizError?(error: ApiError): void
}

const noop = (): void => {}

/**
 * 组装 C 端专用的信封客户端：`baseURL` 拼接 + `Taro.request` 传输 + 会话/租户钩子
 * + 打烊/店铺不可用两个特殊码的分流。
 */
export function createClientRequest(options: ClientRequestOptions): EnvelopeClient {
  const transport = createTaroTransport()
  const prefixed: Transport = {
    request(opts) {
      return transport.request({ ...opts, url: joinUrl(options.baseURL, opts.url) })
    },
  }

  return createEnvelopeClient(prefixed, {
    getToken: options.getToken,
    getTenantSlug: options.getTenantSlug,
    onUnauthorized: options.onUnauthorized ?? noop,
    onForbidden: (error) => {
      if (error.code === ErrorCode.SHOP_CLOSED.code) {
        ;(options.onClosed ?? noop)(error)
        return
      }
      ;(options.onForbidden ?? noop)(error)
    },
    onBizError: (error) => {
      if (error.code === ErrorCode.TENANT_NOT_FOUND.code) {
        ;(options.onTenantMissing ?? noop)(error)
        return
      }
      ;(options.onBizError ?? noop)(error)
    },
  })
}

/** 拼接 baseURL 与相对路径，避免 `//` 或漏掉 `/`。 */
function joinUrl(baseURL: string, url: string): string {
  if (/^https?:\/\//.test(url)) return url
  return `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
}
