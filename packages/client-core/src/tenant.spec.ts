import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = new Map<string, string>()
const getCurrentInstanceMock = vi.fn()

vi.mock('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => storage.get(key) ?? '',
    setStorageSync: (key: string, value: string) => {
      storage.set(key, value)
    },
    getCurrentInstance: () => getCurrentInstanceMock(),
  },
}))

const {
  parseSlugFromH5Path,
  parseSlugFromSubdomain,
  parseSlugFromWeappScene,
  parseSlugFromWeappQuery,
  getStoredTenantSlug,
  setStoredTenantSlug,
  resolveTenantSlug,
} = await import('./tenant')

describe('parseSlugFromH5Path（纯函数）', () => {
  it('从 /s/:slug/... 解析出 slug', () => {
    expect(parseSlugFromH5Path('/s/demo/pages/index')).toBe('demo')
  })

  it('没有 /s/ 前缀时返回 null', () => {
    expect(parseSlugFromH5Path('/pages/index')).toBeNull()
  })

  it('slug 带 URL 编码时会解码', () => {
    expect(parseSlugFromH5Path('/s/%E5%BA%97%E9%93%BA/x')).toBe('店铺')
  })
})

describe('parseSlugFromSubdomain（纯函数）', () => {
  it('从子域名解析出 slug', () => {
    expect(parseSlugFromSubdomain('demo.taizan.vip', { baseDomain: 'taizan.vip' })).toBe('demo')
  })

  it('保留字子域名（如 www）返回 null', () => {
    expect(parseSlugFromSubdomain('www.taizan.vip', { baseDomain: 'taizan.vip' })).toBeNull()
  })

  it('底域不匹配时返回 null', () => {
    expect(parseSlugFromSubdomain('demo.other.com', { baseDomain: 'taizan.vip' })).toBeNull()
  })

  it('多级子域名（非法形状）返回 null', () => {
    expect(parseSlugFromSubdomain('a.b.taizan.vip', { baseDomain: 'taizan.vip' })).toBeNull()
  })
})

describe('小程序启动参数解析（纯函数）', () => {
  it('parseSlugFromWeappQuery 直接读 query.slug', () => {
    expect(parseSlugFromWeappQuery({ slug: 'demo' })).toBe('demo')
    expect(parseSlugFromWeappQuery({})).toBeNull()
    expect(parseSlugFromWeappQuery(undefined)).toBeNull()
  })

  it('parseSlugFromWeappScene 兼容 slug=xxx 形状', () => {
    expect(parseSlugFromWeappScene('slug=demo')).toBe('demo')
  })

  it('parseSlugFromWeappScene 兼容纯 slug 形状', () => {
    expect(parseSlugFromWeappScene('demo-shop')).toBe('demo-shop')
  })

  it('parseSlugFromWeappScene 对空值/不认识的形状返回 null', () => {
    expect(parseSlugFromWeappScene(undefined)).toBeNull()
    expect(parseSlugFromWeappScene('')).toBeNull()
    expect(parseSlugFromWeappScene('id=123')).toBeNull()
  })
})

describe('tenantSlug 持久化', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('setStoredTenantSlug 之后 getStoredTenantSlug 能读回', () => {
    expect(getStoredTenantSlug()).toBeNull()
    setStoredTenantSlug('demo')
    expect(getStoredTenantSlug()).toBe('demo')
  })
})

describe('resolveTenantSlug（三种来源 + 持久化兜底）', () => {
  const originalEnv = process.env.TARO_ENV
  const originalWindow = globalThis.window

  beforeEach(() => {
    storage.clear()
    getCurrentInstanceMock.mockReset()
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

  it('H5：从路径解析成功并持久化', () => {
    process.env.TARO_ENV = 'h5'
    // @ts-expect-error 测试用最小 window mock
    globalThis.window = { location: { pathname: '/s/demo/pages/index', hostname: 'x.com' } }
    expect(resolveTenantSlug()).toBe('demo')
    expect(getStoredTenantSlug()).toBe('demo')
  })

  it('H5：路径解析不出来时回退子域名', () => {
    process.env.TARO_ENV = 'h5'
    // @ts-expect-error 测试用最小 window mock
    globalThis.window = { location: { pathname: '/pages/index', hostname: 'demo.taizan.vip' } }
    expect(resolveTenantSlug({ h5BaseDomain: 'taizan.vip' })).toBe('demo')
  })

  it('H5：都解析不出来时回退持久化值', () => {
    process.env.TARO_ENV = 'h5'
    setStoredTenantSlug('previous')
    // @ts-expect-error 测试用最小 window mock
    globalThis.window = { location: { pathname: '/pages/index', hostname: 'x.com' } }
    expect(resolveTenantSlug()).toBe('previous')
  })

  it('小程序：优先 query.slug', () => {
    process.env.TARO_ENV = 'weapp'
    getCurrentInstanceMock.mockReturnValue({ router: { params: { slug: 'demo' } } })
    expect(resolveTenantSlug()).toBe('demo')
  })

  it('小程序：query.slug 缺失时回退 scene', () => {
    process.env.TARO_ENV = 'weapp'
    getCurrentInstanceMock.mockReturnValue({ router: { params: { scene: 'slug%3Ddemo' } } })
    expect(resolveTenantSlug()).toBe('demo')
  })

  it('小程序：都没有时回退持久化值', () => {
    process.env.TARO_ENV = 'weapp'
    setStoredTenantSlug('previous')
    getCurrentInstanceMock.mockReturnValue({ router: { params: {} } })
    expect(resolveTenantSlug()).toBe('previous')
  })
})
