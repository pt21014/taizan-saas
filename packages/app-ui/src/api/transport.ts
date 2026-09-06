import type { Transport, TransportRequestOptions, TransportResponse } from '@taizan/contracts'

/**
 * RN `fetch` 传输适配（蓝图 §5.1，≤40 行）：只负责发请求、原样把状态码/响应头/响应体
 * 交回去——剥包、错误码分流、token/租户头注入全部是 `createEnvelopeClient` 的职责。
 */
export function createFetchTransport(baseUrl: string): Transport {
  return {
    async request(opts: TransportRequestOptions): Promise<TransportResponse> {
      const qs = opts.params
        ? '?' +
          Object.entries(opts.params)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join('&')
        : ''
      const res = await fetch(`${baseUrl}${opts.url}${qs}`, {
        method: opts.method,
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })

      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        headers[key] = value
      })

      const text = await res.text()
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          // 网关直接拦下、代理层报错等极端情况不是 JSON——原样透传给 classify() 兜底。
          body = text
        }
      }
      return { status: res.status, headers, body }
    },
  }
}
