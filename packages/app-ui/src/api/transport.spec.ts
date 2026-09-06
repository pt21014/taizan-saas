import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFetchTransport } from './transport'

function fakeResponse(opts: {
  status: number
  body?: unknown
  raw?: string
  headers?: Record<string, string>
}) {
  const headers = new Headers(opts.headers ?? {})
  const text = opts.raw ?? (opts.body === undefined ? '' : JSON.stringify(opts.body))
  return { status: opts.status, headers, text: () => Promise.resolve(text) } as unknown as Response
}

describe('createFetchTransport：≤40 行的 RN fetch 传输适配', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GET 把 params 拼进 querystring，且过滤 undefined', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fakeResponse({ status: 200, body: { code: 0, message: 'OK', data: 1 } }))
    vi.stubGlobal('fetch', fetchMock)

    const transport = createFetchTransport('https://api.example.com')
    await transport.request({
      method: 'GET',
      url: '/goods',
      params: { page: 1, keyword: undefined, q: 'a b' },
    })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/goods?page=1&q=a%20b')
  })

  it('POST 把 body 序列化为 JSON，且合并自定义 header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ status: 200, body: { code: 0, message: 'OK', data: null } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const transport = createFetchTransport('https://api.example.com')
    await transport.request({
      method: 'POST',
      url: '/login',
      body: { phone: '13800000000' },
      headers: { 'X-Tenant-Slug': 'demo' },
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ phone: '13800000000' }))
    expect((init.headers as Record<string, string>)['X-Tenant-Slug']).toBe('demo')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('剥出 status / headers / body（JSON 响应）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeResponse({
          status: 200,
          body: { code: 0, message: 'OK', data: { id: '1' } },
          headers: { 'X-Trace-Id': 't-1' },
        }),
      ),
    )
    const transport = createFetchTransport('https://api.example.com')
    const res = await transport.request({ method: 'GET', url: '/x' })
    expect(res.status).toBe(200)
    expect(res.headers['x-trace-id']).toBe('t-1')
    expect(res.body).toEqual({ code: 0, message: 'OK', data: { id: '1' } })
  })

  it('非 JSON 响应体原样透传为字符串，不抛异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse({ status: 502, raw: '<html>Bad Gateway</html>' })),
    )
    const transport = createFetchTransport('https://api.example.com')
    const res = await transport.request({ method: 'GET', url: '/x' })
    expect(res.status).toBe(502)
    expect(res.body).toBe('<html>Bad Gateway</html>')
  })

  it('空响应体解析为 null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ status: 204, raw: '' })))
    const transport = createFetchTransport('https://api.example.com')
    const res = await transport.request({ method: 'DELETE', url: '/x/1' })
    expect(res.body).toBeNull()
  })
})
