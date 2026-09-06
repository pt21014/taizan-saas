import { describe, expect, it, vi } from 'vitest'

import { ErrorCode } from './error-codes'
import {
  ApiError,
  createEnvelopeClient,
  type Transport,
  type TransportRequestOptions,
  type TransportResponse,
} from './envelope-client'

function fakeTransport(
  response: TransportResponse,
): Transport & { calls: TransportRequestOptions[] } {
  const calls: TransportRequestOptions[] = []
  return {
    calls,
    async request(opts) {
      calls.push(opts)
      return response
    },
  }
}

function makeHooks() {
  return {
    getToken: vi.fn<() => string | null>(() => 'token-abc'),
    getTenantSlug: vi.fn<() => string | null>(() => 'demo-shop'),
    onUnauthorized: vi.fn(),
    onForbidden: vi.fn(),
    onBizError: vi.fn(),
  }
}

describe('createEnvelopeClient', () => {
  it('成功路径：get() 剥包只返回 data，且自动加 Authorization/X-Tenant-Slug', async () => {
    const transport = fakeTransport({
      status: 200,
      headers: {},
      body: { code: 0, message: 'OK', data: { id: '1' } },
    })
    const hooks = makeHooks()
    const client = createEnvelopeClient(transport, hooks)

    const data = await client.get<{ id: string }>('/goods', { page: 1 })

    expect(data).toEqual({ id: '1' })
    expect(transport.calls[0]?.headers?.['Authorization']).toBe('Bearer token-abc')
    expect(transport.calls[0]?.headers?.['X-Tenant-Slug']).toBe('demo-shop')
    expect(hooks.onUnauthorized).not.toHaveBeenCalled()
    expect(hooks.onForbidden).not.toHaveBeenCalled()
    expect(hooks.onBizError).not.toHaveBeenCalled()
  })

  it('401 路径：分流到 onUnauthorized 并 reject ApiError', async () => {
    const transport = fakeTransport({
      status: 401,
      headers: { 'X-Trace-Id': 'trace-401' },
      body: { code: 1140100, message: '未登录', data: null },
    })
    const hooks = makeHooks()
    const client = createEnvelopeClient(transport, hooks)

    await expect(client.get('/admin/whoami')).rejects.toBeInstanceOf(ApiError)
    expect(hooks.onUnauthorized).toHaveBeenCalledTimes(1)
    expect(hooks.onForbidden).not.toHaveBeenCalled()
    expect(hooks.onBizError).not.toHaveBeenCalled()

    const err = hooks.onUnauthorized.mock.calls[0]?.[0] as ApiError
    expect(err.code).toBe(1140100)
    expect(err.message).toBe('未登录')
    expect(err.traceId).toBe('trace-401')
  })

  it('403 路径：分流到 onForbidden，只提示不登出', async () => {
    const transport = fakeTransport({
      status: 200,
      headers: { 'x-trace-id': 'trace-403' },
      body: { code: 1440301, message: '套餐已到期，后台暂只读，请续费', data: null },
    })
    const hooks = makeHooks()
    const client = createEnvelopeClient(transport, hooks)

    await expect(client.post('/admin/goods', {})).rejects.toMatchObject({
      code: 1440301,
      traceId: 'trace-403',
    })
    expect(hooks.onForbidden).toHaveBeenCalledTimes(1)
    expect(hooks.onUnauthorized).not.toHaveBeenCalled()
    expect(hooks.onBizError).not.toHaveBeenCalled()
  })

  it('业务错误路径（非 401/403 语义的其他码，如参数错误 400）：分流到 onBizError', async () => {
    // 注意：1540301（配额超限）的 httpSemantic 是 403，会走 onForbidden 分支；
    // 这里特意选一个 httpSemantic===400 的码来验证「其他情况」兜底到 onBizError。
    const transport = fakeTransport({
      status: 200,
      headers: {},
      body: { code: ErrorCode.BAD_REQUEST.code, message: '参数错误', data: null },
    })
    const hooks = makeHooks()
    const client = createEnvelopeClient(transport, hooks)

    await expect(client.post('/admin/goods', {})).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST.code,
    })
    expect(hooks.onBizError).toHaveBeenCalledTimes(1)
    expect(hooks.onUnauthorized).not.toHaveBeenCalled()
    expect(hooks.onForbidden).not.toHaveBeenCalled()
  })

  it('patch()：与 put() 同形，剥包只返回 data，且真的发出 PATCH 方法', async () => {
    const transport = fakeTransport({
      status: 200,
      headers: {},
      body: { code: 0, message: 'OK', data: { status: 'DISABLED' } },
    })
    const hooks = makeHooks()
    const client = createEnvelopeClient(transport, hooks)

    const data = await client.patch<{ status: string }>('/admin/goods/1/disable', { a: 1 })

    expect(data).toEqual({ status: 'DISABLED' })
    expect(transport.calls[0]?.method).toBe('PATCH')
    expect(transport.calls[0]?.body).toEqual({ a: 1 })
  })

  it('raw() 路径：成功时返回完整信封而不剥包', async () => {
    const transport = fakeTransport({
      status: 200,
      headers: {},
      body: { code: 0, message: 'OK', data: [1, 2, 3] },
    })
    const hooks = makeHooks()
    const client = createEnvelopeClient(transport, hooks)

    const envelope = await client.raw<number[]>({ method: 'GET', url: '/admin/goods' })

    expect(envelope).toEqual({ code: 0, message: 'OK', data: [1, 2, 3] })
  })

  it('未登录态（getToken 返回 null）时不加 Authorization 头', async () => {
    const transport = fakeTransport({
      status: 200,
      headers: {},
      body: { code: 0, message: 'OK', data: null },
    })
    const client = createEnvelopeClient(transport, {
      getToken: () => null,
      onUnauthorized: vi.fn(),
      onForbidden: vi.fn(),
      onBizError: vi.fn(),
    })

    await client.get('/public/site-config')

    expect(transport.calls[0]?.headers?.['Authorization']).toBeUndefined()
  })
})
