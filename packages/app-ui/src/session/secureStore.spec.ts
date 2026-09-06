import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const platformState = { OS: 'ios' as 'ios' | 'android' | 'web' }

vi.mock('react-native', () => ({
  Platform: platformState,
}))

const secureStoreMock = {
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}
vi.mock('expo-secure-store', () => secureStoreMock)

describe('sanitizeSecureStoreKey：纯函数，不依赖 RN', () => {
  it('把冒号等非法字符换成下划线（iOS Keychain 只认字母数字和 .-_）', async () => {
    const { sanitizeSecureStoreKey } = await import('./secureStore')
    expect(sanitizeSecureStoreKey('taizan_staff_token:abc123')).toBe('taizan_staff_token_abc123')
    expect(sanitizeSecureStoreKey('a.b-c_d')).toBe('a.b-c_d')
  })
})

describe('secureStore：原生走 expo-secure-store，web 回落 localStorage（mock 存取）', () => {
  beforeEach(() => {
    vi.resetModules()
    secureStoreMock.getItemAsync.mockReset()
    secureStoreMock.setItemAsync.mockReset()
    secureStoreMock.deleteItemAsync.mockReset()
    platformState.OS = 'ios'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('原生：get 转发到 SecureStore.getItemAsync，键已清洗', async () => {
    secureStoreMock.getItemAsync.mockResolvedValue('token-value')
    const { secureStore } = await import('./secureStore')
    const v = await secureStore.get('taizan_member_token:demo')
    expect(v).toBe('token-value')
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledWith('taizan_member_token_demo')
  })

  it('原生：读取抛异常时返回 null，而不是让调用方崩溃', async () => {
    secureStoreMock.getItemAsync.mockRejectedValue(new Error('keychain locked'))
    const { secureStore } = await import('./secureStore')
    await expect(secureStore.get('k')).resolves.toBeNull()
  })

  it('原生：set/remove 都转发且吞掉异常', async () => {
    secureStoreMock.setItemAsync.mockRejectedValue(new Error('disk full'))
    const { secureStore } = await import('./secureStore')
    await expect(secureStore.set('k', 'v')).resolves.toBeUndefined()
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith('k', 'v')

    secureStoreMock.deleteItemAsync.mockResolvedValue(undefined)
    await secureStore.remove('k')
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledWith('k')
  })

  it('web：不碰 SecureStore，走 localStorage', async () => {
    platformState.OS = 'web'
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })

    const { secureStore } = await import('./secureStore')
    await secureStore.set('taizan_x:1', 'hello')
    expect(await secureStore.get('taizan_x:1')).toBe('hello')
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()

    await secureStore.remove('taizan_x:1')
    expect(await secureStore.get('taizan_x:1')).toBeNull()
  })
})
