import { ApiError, ErrorCode, buildErrorCode } from '@taizan/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApiClient, formatWithTrace } from './createApiClient'

function fakeResponse(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
) {
  const h = new Headers(headers)
  return {
    status,
    headers: h,
    text: () => Promise.resolve(JSON.stringify({ code, message, data: null })),
  } as unknown as Response
}

describe('createApiClient：错误分流（蓝图 §4.9 的 httpSemantic 规则）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('401 走 onUnauthorized，不走 onForbidden/onBizError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(401, ErrorCode.UNAUTHENTICATED.code, '未登录')),
    )
    const onUnauthorized = vi.fn()
    const onForbidden = vi.fn()
    const onShopClosed = vi.fn()
    const client = createApiClient('https://api.example.com', {
      getToken: () => 'stale-token',
      onUnauthorized,
      onShopClosed,
      onForbidden,
    })

    await expect(client.get('/me')).rejects.toThrow()
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(onForbidden).not.toHaveBeenCalled()
    expect(onShopClosed).not.toHaveBeenCalled()
  })

  it('1440302（店铺打烊）从 403 里单独摘出来，不落进普通 onForbidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(200, ErrorCode.SHOP_CLOSED.code, '店铺已打烊')),
    )
    const onForbidden = vi.fn()
    const onShopClosed = vi.fn()
    const client = createApiClient('https://api.example.com', {
      getToken: () => 'token',
      onUnauthorized: vi.fn(),
      onShopClosed,
      onForbidden,
    })

    await expect(client.get('/goods')).rejects.toThrow()
    expect(onShopClosed).toHaveBeenCalledWith('店铺已打烊')
    expect(onForbidden).not.toHaveBeenCalled()
  })

  it('普通 403（比如无权限）走 onForbidden，不是打烊', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse(200, ErrorCode.RBAC_FORBIDDEN.code, '无权限')),
    )
    const onForbidden = vi.fn()
    const onShopClosed = vi.fn()
    const client = createApiClient('https://api.example.com', {
      getToken: () => 'token',
      onUnauthorized: vi.fn(),
      onShopClosed,
      onForbidden,
    })

    await expect(client.post('/goods', {})).rejects.toThrow()
    expect(onForbidden).toHaveBeenCalledWith('无权限')
    expect(onShopClosed).not.toHaveBeenCalled()
  })

  it('非 401/403 的业务错误码（如 500）走 onBizError，并把 X-Trace-Id 拼进提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeResponse(200, buildErrorCode(90, 500, 0), '系统内部错误', {
          'X-Trace-Id': 'trace-abc',
        }),
      ),
    )
    const onBizError = vi.fn()
    const client = createApiClient('https://api.example.com', {
      getToken: () => 'token',
      onUnauthorized: vi.fn(),
      onShopClosed: vi.fn(),
      onBizError,
    })

    await expect(client.get('/quota')).rejects.toThrow()
    expect(onBizError).toHaveBeenCalledWith('系统内部错误（追踪号：trace-abc）', 'trace-abc')
  })

  it('成功响应正常剥包返回 data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ code: 0, message: 'OK', data: { id: '1' } })),
      } as unknown as Response),
    )
    const client = createApiClient('https://api.example.com', {
      getToken: () => null,
      onUnauthorized: vi.fn(),
      onShopClosed: vi.fn(),
    })
    await expect(client.get('/goods/1')).resolves.toEqual({ id: '1' })
  })
})

describe('formatWithTrace', () => {
  it('无 traceId 时原样返回 message', () => {
    expect(formatWithTrace(new ApiError(1140100, '未登录', null))).toBe('未登录')
  })

  it('有 traceId 时拼在括号里', () => {
    expect(formatWithTrace(new ApiError(1140100, '未登录', 'tr-1'))).toBe('未登录（追踪号：tr-1）')
  })
})
