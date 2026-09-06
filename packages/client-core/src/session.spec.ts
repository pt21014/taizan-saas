import type { EnvelopeClient } from '@taizan/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = new Map<string, string>()
const taroLogin = vi.fn()

/** 造一个最小的 {@link EnvelopeClient}：只有 `post` 真实可用，其余方法用不到。 */
function fakeEnvelopeClient(
  post: (url: string, body?: unknown) => Promise<unknown>,
): EnvelopeClient {
  return {
    get: () => Promise.reject(new Error('not used in this test')),
    post: post as unknown as EnvelopeClient['post'],
    put: () => Promise.reject(new Error('not used in this test')),
    patch: () => Promise.reject(new Error('not used in this test')),
    delete: () => Promise.reject(new Error('not used in this test')),
    raw: () => Promise.reject(new Error('not used in this test')),
  }
}

vi.mock('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => storage.get(key) ?? '',
    setStorageSync: (key: string, value: string) => {
      storage.set(key, value)
    },
    removeStorageSync: (key: string) => {
      storage.delete(key)
    },
    login: (...args: unknown[]) => taroLogin(...args),
  },
}))

const { getMemberToken, setMemberToken, clearMemberToken, createSession } =
  await import('./session')

describe('member token 持久化', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('未登录时 getMemberToken 返回 null', () => {
    expect(getMemberToken()).toBeNull()
  })

  it('setMemberToken 之后 getMemberToken 能读回', () => {
    setMemberToken('tok-1')
    expect(getMemberToken()).toBe('tok-1')
  })

  it('clearMemberToken 之后恢复未登录', () => {
    setMemberToken('tok-1')
    clearMemberToken()
    expect(getMemberToken()).toBeNull()
  })
})

describe('createSession', () => {
  beforeEach(() => {
    storage.clear()
    taroLogin.mockReset()
  })

  it('loginDev：调用 /api/client/auth/login-dev 并落盘 token', async () => {
    const post = vi.fn().mockResolvedValue({ access: 'tok-dev', member: { id: 'm1' } })
    const session = createSession(fakeEnvelopeClient(post))

    const result = await session.loginDev('13700000001')

    expect(post).toHaveBeenCalledWith('/api/client/auth/login-dev', { phone: '13700000001' })
    expect(result.access).toBe('tok-dev')
    expect(getMemberToken()).toBe('tok-dev')
    expect(session.isLoggedIn()).toBe(true)
  })

  it('loginWechat：Taro.login() 拿到 code 后请求换 token 的请求形状', async () => {
    taroLogin.mockResolvedValue({ code: 'wx-code-1' })
    const post = vi.fn().mockResolvedValue({ access: 'tok-wx' })
    const session = createSession(fakeEnvelopeClient(post))

    const result = await session.loginWechat()

    expect(post).toHaveBeenCalledWith('/api/client/auth/login-wechat', { code: 'wx-code-1' })
    expect(result.access).toBe('tok-wx')
    expect(getMemberToken()).toBe('tok-wx')
  })

  it('loginWechat：Taro.login() 未返回 code 时抛错且不调用后端', async () => {
    taroLogin.mockResolvedValue({ code: '' })
    const post = vi.fn()
    const session = createSession(fakeEnvelopeClient(post))

    await expect(session.loginWechat()).rejects.toThrow()
    expect(post).not.toHaveBeenCalled()
  })

  it('logout：清空 token', async () => {
    setMemberToken('tok-x')
    const session = createSession(fakeEnvelopeClient(() => Promise.resolve(null)))
    session.logout()
    expect(getMemberToken()).toBeNull()
  })
})
