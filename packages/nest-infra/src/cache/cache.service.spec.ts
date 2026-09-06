import RedisMock from 'ioredis-mock'
import { beforeEach, describe, expect, it } from 'vitest'
import { runWithContext, type RequestContext } from '@taizan/nest-core'
import { DEFAULT_KEY_PREFIX, RedisService } from '../redis/redis.service'
import type { RedisClient } from '../redis/redis-client'
import { CacheService } from './cache.service'
import { buildCacheKey, CacheTenantContextError } from './key-builder'

function ctx(tenantId?: string): RequestContext {
  return {
    traceId: 'T-1',
    tenantId,
    ip: { client: '1.1.1.1', edge: '1.1.1.1' },
    startedAt: Date.now(),
  }
}

describe('CacheService', () => {
  let client: RedisClient
  let cache: CacheService

  beforeEach(() => {
    client = new RedisMock() as unknown as RedisClient
    cache = new CacheService(new RedisService(client, DEFAULT_KEY_PREFIX))
  })

  it('key 规则是 t:{tenantId}:{ns}:{k}', async () => {
    await runWithContext(ctx('01HTENANTAAAAAAAAAAAAAAAAA'), async () => {
      expect(cache.keyOf('goods', 'g-1')).toBe('t:01HTENANTAAAAAAAAAAAAAAAAA:goods:g-1')
      await cache.set('goods', 'g-1', { name: '拿铁' }, 60)
      expect(await client.get('taizan:t:01HTENANTAAAAAAAAAAAAAAAAA:goods:g-1')).toBe(
        JSON.stringify({ name: '拿铁' }),
      )
      expect(await cache.get('goods', 'g-1')).toEqual({ name: '拿铁' })
    })
  })

  // 用例 ⑥
  it('无租户上下文 + 非 platform 命名空间 → 抛（读写都抛）', async () => {
    await runWithContext(ctx(undefined), async () => {
      await expect(cache.set('goods', 'g-1', 1, 60)).rejects.toBeInstanceOf(CacheTenantContextError)
      await expect(cache.get('goods', 'g-1')).rejects.toBeInstanceOf(CacheTenantContextError)
      await expect(cache.delNs('goods')).rejects.toBeInstanceOf(CacheTenantContextError)
      await expect(cache.takeOnce('goods', 'g-1')).rejects.toBeInstanceOf(CacheTenantContextError)
    })
  })

  it('压根没有上下文（裸脚本 / cron）时同样抛', async () => {
    await expect(cache.set('goods', 'g-1', 1, 60)).rejects.toThrow(/需要租户上下文/)
  })

  // 用例 ⑥（放行侧）
  it('platform: 命名空间在无租户上下文下放行，落在 t:platform: 槽位', async () => {
    await cache.set('platform:plan', 'p-1', { name: '旗舰版' }, 60)
    expect(cache.keyOf('platform:plan', 'p-1')).toBe('t:platform:platform:plan:p-1')
    expect(await cache.get('platform:plan', 'p-1')).toEqual({ name: '旗舰版' })
  })

  it('platform: 命名空间即使在租户上下文里也走 platform 槽位（否则每个租户各存一份，清不干净）', () => {
    const inTenant = runWithContext(ctx('01HTENANTAAAAAAAAAAAAAAAAA'), () =>
      cache.keyOf('platform:plan', 'p-1'),
    )
    expect(inTenant).toBe('t:platform:platform:plan:p-1')
  })

  // 用例 ⑩
  it('delNs 只删本租户本命名空间，别的租户与别的命名空间不受影响', async () => {
    const A = '01HTENANTAAAAAAAAAAAAAAAAA'
    const B = '01HTENANTBBBBBBBBBBBBBBBBB'

    await runWithContext(ctx(A), async () => {
      await cache.set('goods', 'g-1', 1, 60)
      await cache.set('goods', 'g-2', 2, 60)
      await cache.set('member', 'm-1', 3, 60)
    })
    await runWithContext(ctx(B), async () => {
      await cache.set('goods', 'g-1', 9, 60)
    })
    await cache.set('platform:plan', 'p-1', 'x', 60)

    const removed = await runWithContext(ctx(A), () => cache.delNs('goods'))
    expect(removed).toBe(2)

    await runWithContext(ctx(A), async () => {
      expect(await cache.get('goods', 'g-1')).toBeNull()
      expect(await cache.get('goods', 'g-2')).toBeNull()
      // 同租户别的命名空间还在
      expect(await cache.get('member', 'm-1')).toBe(3)
    })
    // 别的租户还在
    expect(await runWithContext(ctx(B), () => cache.get('goods', 'g-1'))).toBe(9)
    // 平台级还在
    expect(await cache.get('platform:plan', 'p-1')).toBe('x')
  })

  it('takeOnce 第二次返回 null', async () => {
    await cache.set('platform:oauth-state', 's-1', { tenantId: 'T1' }, 60)
    expect(await cache.takeOnce('platform:oauth-state', 's-1')).toEqual({ tenantId: 'T1' })
    expect(await cache.takeOnce('platform:oauth-state', 's-1')).toBeNull()
  })

  it('ttlSec 必须是正数', async () => {
    await cache.set('platform:x', 'k', 1, 1)
    await expect(cache.set('platform:x', 'k', 1, 0)).rejects.toThrow(/ttlSec 必须是正数/)
  })

  it('命名空间不允许带通配符（否则 delNs 的匹配面会失控）', () => {
    expect(() => buildCacheKey('goo*', 'k', 'T1')).toThrow(/不允许含通配符/)
    expect(() => buildCacheKey('', 'k', 'T1')).toThrow(/不能为空/)
  })

  it('缓存里存的是坏 JSON 时退化成未命中，而不是抛', async () => {
    await client.set('taizan:t:platform:platform:x:k', '{坏掉的', 'PX', 60_000)
    expect(await cache.get('platform:x', 'k')).toBeNull()
  })
})
