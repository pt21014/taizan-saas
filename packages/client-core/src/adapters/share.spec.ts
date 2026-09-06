import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const showShareMenu = vi.fn()
const setClipboardData = vi.fn()

vi.mock('@tarojs/taro', () => ({
  default: {
    showShareMenu: (...args: unknown[]) => showShareMenu(...args),
    setClipboardData: (...args: unknown[]) => setClipboardData(...args),
  },
}))

const { share, buildShareConfig } = await import('./share')

const PARAMS = { title: '标题', path: '/pages/goods/detail?id=1' }

describe('share：process.env.TARO_ENV 条件编译', () => {
  const originalEnv = process.env.TARO_ENV
  const originalWindow = globalThis.window

  beforeEach(() => {
    showShareMenu.mockReset().mockResolvedValue({ errMsg: 'ok' })
    setClipboardData.mockReset().mockResolvedValue({ errMsg: 'ok' })
  })

  afterEach(() => {
    process.env.TARO_ENV = originalEnv
    if (originalWindow === undefined) {
      // @ts-expect-error 测试环境清理
      delete globalThis.window
    } else {
      globalThis.window = originalWindow
    }
  })

  it('weapp：打开系统转发菜单，不写剪贴板', async () => {
    process.env.TARO_ENV = 'weapp'
    const result = await share(PARAMS)
    expect(showShareMenu).toHaveBeenCalledTimes(1)
    expect(setClipboardData).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, via: 'wechat-menu' })
  })

  it('h5：写剪贴板并带上完整链接', async () => {
    process.env.TARO_ENV = 'h5'
    // @ts-expect-error 测试用最小 window mock
    globalThis.window = { location: { origin: 'https://demo.taizan.vip' } }

    const result = await share(PARAMS)

    expect(showShareMenu).not.toHaveBeenCalled()
    expect(setClipboardData).toHaveBeenCalledWith({
      data: 'https://demo.taizan.vip/pages/goods/detail?id=1',
    })
    expect(result).toEqual({
      ok: true,
      via: 'clipboard',
      url: 'https://demo.taizan.vip/pages/goods/detail?id=1',
    })
  })
})

describe('buildShareConfig（纯函数）', () => {
  it('原样透出小程序 onShareAppMessage 需要的字段', () => {
    expect(buildShareConfig({ ...PARAMS, imageUrl: 'https://x/y.png' })).toEqual({
      title: '标题',
      path: '/pages/goods/detail?id=1',
      imageUrl: 'https://x/y.png',
    })
  })
})
