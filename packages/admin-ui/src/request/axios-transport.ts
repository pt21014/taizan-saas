import axios from 'axios'
import type { Transport, TransportRequestOptions, TransportResponse } from '@taizan/contracts'

/**
 * axios 传输适配（蓝图 §5.1，≤40 行）：只管把请求发出去、把 axios 响应原样转成
 * {@link TransportResponse}。剥包、错误码分流、traceId 提取一律不在这里做——
 * 那是 `@taizan/contracts` 的 `createEnvelopeClient` 的职责，两边混在一起下次改错误处理
 * 就要同时改四端传输层。
 */
export function createAxiosTransport(baseURL: string): Transport {
  const instance = axios.create({ baseURL, timeout: 15_000 })

  return {
    async request(opts: TransportRequestOptions): Promise<TransportResponse> {
      const res = await instance.request({
        url: opts.url,
        method: opts.method,
        params: opts.params,
        data: opts.body,
        headers: opts.headers,
        // 非 2xx 也要把信封 body 原样交给上层分流，不能让 axios 直接 reject 掉响应体
        validateStatus: () => true,
      })
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries((res.headers ?? {}) as Record<string, unknown>)) {
        if (typeof value === 'string') headers[key] = value
      }
      return { status: res.status, headers, body: res.data as unknown }
    },
  }
}
