import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const chooseImage = vi.fn()

vi.mock('@tarojs/taro', () => ({
  default: { chooseImage: (...args: unknown[]) => chooseImage(...args) },
}))

const { chooseImage: chooseImageAdapter } = await import('./media')

describe('chooseImage：process.env.TARO_ENV 条件编译', () => {
  const originalEnv = process.env.TARO_ENV

  beforeEach(() => {
    chooseImage.mockReset()
    chooseImage.mockResolvedValue({ tempFilePaths: ['/tmp/a.jpg'], tempFiles: [] })
  })

  afterEach(() => {
    process.env.TARO_ENV = originalEnv
  })

  it('weapp：默认 sourceType 含 album + camera', async () => {
    process.env.TARO_ENV = 'weapp'
    await chooseImageAdapter()
    expect(chooseImage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: ['album', 'camera'] }),
    )
  })

  it('h5：强制只用 album（浏览器没有相机来源区分）', async () => {
    process.env.TARO_ENV = 'h5'
    await chooseImageAdapter({ sourceType: ['album', 'camera'] })
    expect(chooseImage).toHaveBeenCalledWith(expect.objectContaining({ sourceType: ['album'] }))
  })

  it('返回值只透出 tempFilePaths', async () => {
    process.env.TARO_ENV = 'weapp'
    const result = await chooseImageAdapter({ count: 3 })
    expect(result).toEqual({ tempFilePaths: ['/tmp/a.jpg'] })
    expect(chooseImage).toHaveBeenCalledWith(expect.objectContaining({ count: 3 }))
  })
})
