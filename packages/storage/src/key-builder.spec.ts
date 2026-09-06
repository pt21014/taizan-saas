import { describe, expect, it } from 'vitest'
import {
  buildPlatformKey,
  buildTenantKey,
  isPlatformKey,
  isTenantKey,
  tenantIdOfKey,
} from './key-builder'

describe('buildTenantKey', () => {
  it('生成 t/{tenantId}/{ns}/{ulid}.{ext} 形状的 key', () => {
    const key = buildTenantKey('tnt01', 'goods-image', '.jpg')
    expect(key).toMatch(/^t\/tnt01\/goods-image\/[0-9A-Z]{26}\.jpg$/)
  })

  it('ext 不带前导点也能用', () => {
    const key = buildTenantKey('tnt01', 'goods-image', 'png')
    expect(key.endsWith('.png')).toBe(true)
  })

  it('没有 tenantId 时抛错——没有回落到平台前缀这回事', () => {
    expect(() => buildTenantKey(undefined, 'ns', '.jpg')).toThrow('缺少 tenantId')
    expect(() => buildTenantKey(null, 'ns', '.jpg')).toThrow('缺少 tenantId')
    expect(() => buildTenantKey('', 'ns', '.jpg')).toThrow('缺少 tenantId')
  })

  it('ns 含斜杠时抛错——防止 key 越出租户前缀目录', () => {
    expect(() => buildTenantKey('tnt01', 'a/b', '.jpg')).toThrow('非法的命名空间')
    expect(() => buildTenantKey('tnt01', '../escape', '.jpg')).toThrow('非法的命名空间')
  })

  it('扩展名不在白名单时抛错', () => {
    expect(() => buildTenantKey('tnt01', 'ns', '.exe')).toThrow('不支持的扩展名')
    expect(() => buildTenantKey('tnt01', 'ns', '.html')).toThrow('不支持的扩展名')
  })

  it('两次调用生成不同的 key（ulid 不重复）', () => {
    const a = buildTenantKey('tnt01', 'ns', '.jpg')
    const b = buildTenantKey('tnt01', 'ns', '.jpg')
    expect(a).not.toBe(b)
  })
})

describe('buildPlatformKey', () => {
  it('生成 p/{ns}/{ulid}.{ext} 形状的 key，不含租户段', () => {
    const key = buildPlatformKey('announcement', '.png')
    expect(key).toMatch(/^p\/announcement\/[0-9A-Z]{26}\.png$/)
  })

  it('是显式 API，不接受 tenantId 参数——调用点必须自己写明这是平台域', () => {
    expect(buildPlatformKey.length).toBe(2)
  })
})

describe('域判定与反解', () => {
  it('isTenantKey / isPlatformKey 按前缀区分', () => {
    expect(isTenantKey('t/a/b/c.jpg')).toBe(true)
    expect(isTenantKey('p/a/b.jpg')).toBe(false)
    expect(isPlatformKey('p/a/b.jpg')).toBe(true)
    expect(isPlatformKey('t/a/b/c.jpg')).toBe(false)
  })

  it('tenantIdOfKey 从租户域 key 里取出 tenantId，仅供排障', () => {
    const key = buildTenantKey('tnt01', 'ns', '.jpg')
    expect(tenantIdOfKey(key)).toBe('tnt01')
  })

  it('非租户域 key 或格式不对时返回 null', () => {
    expect(tenantIdOfKey('p/ns/x.jpg')).toBeNull()
    expect(tenantIdOfKey('t/onlytenant')).toBeNull()
  })
})
