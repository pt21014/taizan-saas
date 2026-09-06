import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { BootstrapResponse } from '@taizan/contracts'

// axios 是 peerDependency，不真的发网络请求：mock `axios.create()` 返回的实例，
// 用 mockRequest 依次控制每一次请求的响应体。
const mockRequest = vi.fn()
vi.mock('axios', () => ({
  default: { create: () => ({ request: mockRequest }) },
}))

const { createSessionStore } = await import('./store')

function respond(body: unknown, status = 200, headers: Record<string, string> = {}) {
  mockRequest.mockResolvedValueOnce({ status, headers, data: body })
}

const bootstrapFixture: BootstrapResponse = {
  identity: { staffId: 's1', accountId: 'a1', name: '张三', isOwner: true },
  tenant: {
    id: 't1',
    slug: 'shop-1',
    name: '一号店',
    status: 'ACTIVE',
    planExpireAt: null,
    readonly: false,
    features: null,
  },
  shops: [{ tenantId: 't1', name: '一号店', slug: 'shop-1' }],
  permissions: ['goods:list'],
  menus: [],
  quotas: {},
}

describe('createSessionStore().login', () => {
  beforeEach(() => {
    mockRequest.mockReset()
    localStorage.clear()
  })

  it('名下多店时返回选店列表，不落 token，也不会自动 bootstrap', async () => {
    respond({
      code: 0,
      message: 'OK',
      data: {
        needChooseShop: true,
        shops: [{ tenantId: 't1', name: '一号店', slug: 'shop-1', isOwner: true }],
      },
    })
    const useSession = createSessionStore({ baseURL: '/api', storageKeyPrefix: 'test-multi' })

    const result = await useSession.getState().login('13900000001', 'pwd')

    expect(result).toEqual([{ tenantId: 't1', name: '一号店', slug: 'shop-1', isOwner: true }])
    expect(useSession.getState().token).toBeNull()
    expect(useSession.getState().status).toBe('idle')
    // 只调了一次 login，没有紧接着调 bootstrap
    expect(mockRequest).toHaveBeenCalledTimes(1)
  })

  it('单店直接登录：落 token 并自动 bootstrap 填充会话', async () => {
    respond({
      code: 0,
      message: 'OK',
      data: {
        needChooseShop: false,
        access: 'tok-1',
        refresh: 'r',
        expiresIn: 3600,
        staffId: 's1',
        tenantId: 't1',
        shops: [],
      },
    })
    respond({ code: 0, message: 'OK', data: bootstrapFixture })
    const useSession = createSessionStore({ baseURL: '/api', storageKeyPrefix: 'test-single' })

    const result = await useSession.getState().login('13900000001', 'pwd')

    expect(result).toBeNull()
    expect(useSession.getState().token).toBe('tok-1')
    expect(useSession.getState().status).toBe('ready')
    expect(useSession.getState().identity?.name).toBe('张三')
    expect(useSession.getState().menus).toEqual([])
    expect(mockRequest).toHaveBeenCalledTimes(2)
  })

  it('选店后带 tenantId 再登录一次：走同一个 login 接口，带上选中的 tenantId', async () => {
    respond({
      code: 0,
      message: 'OK',
      data: {
        needChooseShop: false,
        access: 'tok-2',
        refresh: 'r',
        expiresIn: 3600,
        staffId: 's1',
        tenantId: 't2',
        shops: [],
      },
    })
    respond({ code: 0, message: 'OK', data: bootstrapFixture })
    const useSession = createSessionStore({ baseURL: '/api', storageKeyPrefix: 'test-choose' })

    const result = await useSession.getState().login('13900000001', 'pwd', 't2')

    expect(result).toBeNull()
    expect(mockRequest.mock.calls[0]?.[0]).toMatchObject({
      data: { phone: '13900000001', password: 'pwd', tenantId: 't2' },
    })
  })

  it('identifierField: "username" 时 login() 发出去的 body 用 username 而不是 phone（T3-4：平台超管用户名登录）', async () => {
    respond({
      code: 0,
      message: 'OK',
      data: {
        access: 'tok-p1',
        refresh: 'r',
        expiresIn: 3600,
        admin: { id: 'p1', username: 'admin', name: '超管' },
      },
    })
    respond({ code: 0, message: 'OK', data: bootstrapFixture })
    const useSession = createSessionStore({
      baseURL: '/api',
      storageKeyPrefix: 'test-username',
      identifierField: 'username',
      endpoints: { login: '/api/platform/auth/login', bootstrap: '/api/platform/auth/bootstrap' },
    })

    const result = await useSession.getState().login('admin', 'pwd')

    expect(result).toBeNull()
    expect(mockRequest.mock.calls[0]?.[0]).toMatchObject({
      url: '/api/platform/auth/login',
      data: { username: 'admin', password: 'pwd' },
    })
    expect(mockRequest.mock.calls[0]?.[0]?.data).not.toHaveProperty('phone')
    expect(mockRequest.mock.calls[1]?.[0]).toMatchObject({ url: '/api/platform/auth/bootstrap' })
  })

  it('不传 endpoints/identifierField 时沿用旧默认值（对 apps/admin 零破坏）', async () => {
    respond({
      code: 0,
      message: 'OK',
      data: {
        needChooseShop: false,
        access: 'tok-4',
        refresh: 'r',
        expiresIn: 3600,
        staffId: 's1',
        tenantId: 't1',
        shops: [],
      },
    })
    respond({ code: 0, message: 'OK', data: bootstrapFixture })
    const useSession = createSessionStore({ baseURL: '/api', storageKeyPrefix: 'test-default' })

    await useSession.getState().login('13900000001', 'pwd')

    expect(mockRequest.mock.calls[0]?.[0]).toMatchObject({
      url: '/api/admin/auth/login',
      data: { phone: '13900000001', password: 'pwd' },
    })
    expect(mockRequest.mock.calls[1]?.[0]).toMatchObject({ url: '/api/admin/auth/bootstrap' })
  })

  it('storageKey 是 storageKeyPrefix 的新别名，同时传时 storageKey 优先', async () => {
    localStorage.setItem('by-new-name_token', 'tok-new')
    localStorage.setItem('by-old-name_token', 'tok-old')
    const useSession = createSessionStore({
      baseURL: '/api',
      storageKey: 'by-new-name',
      storageKeyPrefix: 'by-old-name',
    })

    expect(useSession.getState().token).toBe('tok-new')
  })

  it('logout 清空会话字段', async () => {
    respond({
      code: 0,
      message: 'OK',
      data: {
        needChooseShop: false,
        access: 'tok-3',
        refresh: 'r',
        expiresIn: 3600,
        staffId: 's1',
        tenantId: 't1',
        shops: [],
      },
    })
    respond({ code: 0, message: 'OK', data: bootstrapFixture })
    const useSession = createSessionStore({ baseURL: '/api', storageKeyPrefix: 'test-logout' })
    await useSession.getState().login('13900000001', 'pwd')

    useSession.getState().logout()

    expect(useSession.getState().token).toBeNull()
    expect(useSession.getState().identity).toBeNull()
    expect(useSession.getState().status).toBe('idle')
  })
})
