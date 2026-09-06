import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ErrorCode } from '@taizan/contracts'

// axios 是 peerDependency，测试里不真的发网络请求：mock `axios.create()` 返回的实例，
// 直接控制 `request()` 的响应体，验证 createRequest 的错误码分流与剥包逻辑。
const mockRequest = vi.fn()
vi.mock('axios', () => ({
  default: {
    create: () => ({ request: mockRequest }),
  },
}))

// 必须在 mock 之后再 import，保证 axios-transport.ts 里 `axios.create()` 用到的是 mock
const { createRequest } = await import('./create-request')

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  mockRequest.mockResolvedValueOnce({ status, headers, data: body })
}

describe('createRequest', () => {
  beforeEach(() => {
    mockRequest.mockReset()
  })

  function makeHooks() {
    return {
      baseURL: '/api',
      getToken: () => 'token-abc',
      onUnauthorized: vi.fn(),
      onForbidden: vi.fn(),
      onBizError: vi.fn(),
      onReadonly: vi.fn(),
    }
  }

  it('剥包正确：成功响应只返回 data', async () => {
    respond(200, { code: 0, message: 'OK', data: { id: 'goods-1' } })
    const hooks = makeHooks()
    const client = createRequest(hooks)

    const data = await client.get<{ id: string }>('/admin/goods/1')

    expect(data).toEqual({ id: 'goods-1' })
  })

  it('401：调 onUnauthorized，不调 onForbidden/onBizError', async () => {
    respond(401, { code: 1140100, message: '未登录', data: null })
    const hooks = makeHooks()
    const client = createRequest(hooks)

    await expect(client.get('/admin/whoami')).rejects.toMatchObject({ code: 1140100 })

    expect(hooks.onUnauthorized).toHaveBeenCalledTimes(1)
    expect(hooks.onForbidden).not.toHaveBeenCalled()
    expect(hooks.onBizError).not.toHaveBeenCalled()
    expect(hooks.onReadonly).not.toHaveBeenCalled()
  })

  it('1440301（套餐到期只读）：调 onReadonly，不调 onForbidden', async () => {
    respond(200, { code: 1440301, message: '套餐已到期，后台暂只读，请续费', data: null })
    const hooks = makeHooks()
    const client = createRequest(hooks)

    await expect(client.post('/admin/goods', {})).rejects.toMatchObject({ code: 1440301 })

    expect(hooks.onReadonly).toHaveBeenCalledTimes(1)
    expect(hooks.onForbidden).not.toHaveBeenCalled()
    expect(hooks.onUnauthorized).not.toHaveBeenCalled()
  })

  it('普通 403（如无权限）：仍走 onForbidden，不误判成 onReadonly', async () => {
    respond(200, { code: ErrorCode.RBAC_FORBIDDEN.code, message: '无权限', data: null })
    const hooks = makeHooks()
    const client = createRequest(hooks)

    await expect(client.post('/admin/goods', {})).rejects.toMatchObject({
      code: ErrorCode.RBAC_FORBIDDEN.code,
    })

    expect(hooks.onForbidden).toHaveBeenCalledTimes(1)
    expect(hooks.onReadonly).not.toHaveBeenCalled()
  })

  it('traceId 从响应头 X-Trace-Id 带进错误对象', async () => {
    respond(
      200,
      { code: 1440301, message: '套餐已到期', data: null },
      { 'X-Trace-Id': 'trace-xyz' },
    )
    const hooks = makeHooks()
    const client = createRequest(hooks)

    await expect(client.post('/admin/goods', {})).rejects.toMatchObject({ traceId: 'trace-xyz' })
  })
})
