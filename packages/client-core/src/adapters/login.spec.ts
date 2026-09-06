import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const taroLogin = vi.fn()

vi.mock('@tarojs/taro', () => ({
  default: { login: (...args: unknown[]) => taroLogin(...args) },
}))

const { loginWithPlatform } = await import('./login')

describe('loginWithPlatform：process.env.TARO_ENV 条件编译', () => {
  const originalEnv = process.env.TARO_ENV

  beforeEach(() => {
    taroLogin.mockReset()
  })

  afterEach(() => {
    process.env.TARO_ENV = originalEnv
  })

  it('weapp：调用 Taro.login() 并透出 code', async () => {
    process.env.TARO_ENV = 'weapp'
    taroLogin.mockResolvedValue({ code: 'wx-code' })
    const result = await loginWithPlatform()
    expect(taroLogin).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ supported: true, code: 'wx-code' })
  })

  it('weapp：Taro.login() 没给 code 时 supported=false', async () => {
    process.env.TARO_ENV = 'weapp'
    taroLogin.mockResolvedValue({ code: '' })
    const result = await loginWithPlatform()
    expect(result).toEqual({ supported: false })
  })

  it('h5：直接 supported=false，且不调用 Taro.login()', async () => {
    process.env.TARO_ENV = 'h5'
    const result = await loginWithPlatform()
    expect(taroLogin).not.toHaveBeenCalled()
    expect(result).toEqual({ supported: false })
  })
})
