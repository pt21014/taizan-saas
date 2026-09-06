import { ErrorCode } from '@taizan/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const taroRequest = vi.fn()

vi.mock('@tarojs/taro', () => ({
  default: { request: (...args: unknown[]) => taroRequest(...args) },
}))

// 必须在 mock 之后再 import，否则拿到的是未被替换的真实模块。
const { createTaroTransport, createClientRequest } = await import('./request')

function envelope(code: number, data: unknown = null, message = ''): unknown {
  return { code, message, data }
}

describe('createTaroTransport', () => {
  beforeEach(() => {
    taroRequest.mockReset()
  })

  it('GET/DELETE 把 params 当 data 传，POST/PUT 把 body 当 data 传', async () => {
    taroRequest.mockResolvedValue({ statusCode: 200, header: {}, data: envelope(0, 'ok') })
    const transport = createTaroTransport()

    await transport.request({ method: 'GET', url: '/x', params: { a: 1 } })
    expect(taroRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'GET', data: { a: 1 } }),
    )

    await transport.request({ method: 'POST', url: '/x', body: { b: 2 } })
    expect(taroRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'POST', data: { b: 2 } }),
    )
  })

  it('把 Taro.request 的返回值整形成 status/headers/body', async () => {
    taroRequest.mockResolvedValue({
      statusCode: 200,
      header: { 'X-Trace-Id': 't-1' },
      data: envelope(0, { ok: true }),
    })
    const transport = createTaroTransport()
    const res = await transport.request({ method: 'GET', url: '/x' })
    expect(res.status).toBe(200)
    expect(res.headers['X-Trace-Id']).toBe('t-1')
    expect(res.body).toEqual(envelope(0, { ok: true }))
  })
})

describe('createClientRequest', () => {
  beforeEach(() => {
    taroRequest.mockReset()
  })

  function setup(overrides: Partial<Parameters<typeof createClientRequest>[0]> = {}) {
    const hooks = {
      onUnauthorized: vi.fn(),
      onClosed: vi.fn(),
      onTenantMissing: vi.fn(),
      onForbidden: vi.fn(),
      onBizError: vi.fn(),
    }
    const client = createClientRequest({
      baseURL: 'https://api.example.com',
      getToken: () => 'tok-1',
      getTenantSlug: () => 'demo',
      ...hooks,
      ...overrides,
    })
    return { client, hooks }
  }

  it('剥包：成功响应直接拿到 data', async () => {
    taroRequest.mockResolvedValue({ statusCode: 200, header: {}, data: envelope(0, { id: 1 }) })
    const { client } = setup()
    await expect(client.get('/api/client/goods')).resolves.toEqual({ id: 1 })
  })

  it('拼接 baseURL + 注入 Authorization / X-Tenant-Slug', async () => {
    taroRequest.mockResolvedValue({ statusCode: 200, header: {}, data: envelope(0, null) })
    const { client } = setup()
    await client.get('/api/client/goods')
    expect(taroRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.com/api/client/goods',
        header: expect.objectContaining({
          Authorization: 'Bearer tok-1',
          'X-Tenant-Slug': 'demo',
        }),
      }),
    )
  })

  it('401 分流到 onUnauthorized', async () => {
    taroRequest.mockResolvedValue({
      statusCode: 200,
      header: {},
      data: envelope(ErrorCode.UNAUTHENTICATED.code, null, ErrorCode.UNAUTHENTICATED.message),
    })
    const { client, hooks } = setup()
    await expect(client.get('/x')).rejects.toThrow()
    expect(hooks.onUnauthorized).toHaveBeenCalledTimes(1)
    expect(hooks.onClosed).not.toHaveBeenCalled()
  })

  it('1440302（SHOP_CLOSED）分流到 onClosed，不落到 onForbidden', async () => {
    taroRequest.mockResolvedValue({
      statusCode: 200,
      header: {},
      data: envelope(ErrorCode.SHOP_CLOSED.code, null, ErrorCode.SHOP_CLOSED.message),
    })
    const { client, hooks } = setup()
    await expect(client.get('/x')).rejects.toThrow()
    expect(hooks.onClosed).toHaveBeenCalledTimes(1)
    expect(hooks.onForbidden).not.toHaveBeenCalled()
  })

  it('其余 403（如 FORBIDDEN）仍然分流到 onForbidden', async () => {
    taroRequest.mockResolvedValue({
      statusCode: 200,
      header: {},
      data: envelope(ErrorCode.RBAC_FORBIDDEN.code, null, ErrorCode.RBAC_FORBIDDEN.message),
    })
    const { client, hooks } = setup()
    await expect(client.get('/x')).rejects.toThrow()
    expect(hooks.onForbidden).toHaveBeenCalledTimes(1)
    expect(hooks.onClosed).not.toHaveBeenCalled()
  })

  it('1240400（TENANT_NOT_FOUND）分流到 onTenantMissing，不落到 onBizError', async () => {
    taroRequest.mockResolvedValue({
      statusCode: 200,
      header: {},
      data: envelope(ErrorCode.TENANT_NOT_FOUND.code, null, ErrorCode.TENANT_NOT_FOUND.message),
    })
    const { client, hooks } = setup()
    await expect(client.get('/x')).rejects.toThrow()
    expect(hooks.onTenantMissing).toHaveBeenCalledTimes(1)
    expect(hooks.onBizError).not.toHaveBeenCalled()
  })

  it('其余业务错误（如 BAD_REQUEST）分流到 onBizError', async () => {
    taroRequest.mockResolvedValue({
      statusCode: 200,
      header: {},
      data: envelope(ErrorCode.BAD_REQUEST.code, null, ErrorCode.BAD_REQUEST.message),
    })
    const { client, hooks } = setup()
    await expect(client.get('/x')).rejects.toThrow()
    expect(hooks.onBizError).toHaveBeenCalledTimes(1)
    expect(hooks.onTenantMissing).not.toHaveBeenCalled()
  })

  it('getToken 返回 null 时不带 Authorization 头', async () => {
    taroRequest.mockResolvedValue({ statusCode: 200, header: {}, data: envelope(0, null) })
    const { client } = setup({ getToken: () => null })
    await client.get('/x')
    const call = taroRequest.mock.calls[0]?.[0] as { header: Record<string, string> }
    expect(call.header.Authorization).toBeUndefined()
  })
})
