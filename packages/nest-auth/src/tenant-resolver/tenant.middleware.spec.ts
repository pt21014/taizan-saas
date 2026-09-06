/**
 * 解析链的顺序不变量 + 蓝图 spec 16 的源码比对。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvableRequest, TenantResolverStrategy } from './strategy'
import {
  isApiPath,
  isTenantFreePath,
  isTokenOnlyTenantPath,
  NON_API_FRAMEWORK_PREFIXES,
  requestPath,
  TENANT_FREE_PREFIXES,
  TENANT_TOKEN_ONLY_PREFIXES,
} from './strategy'
import { TenantMiddleware, TenantResolverChain } from './tenant.middleware'

function req(overrides: Partial<ResolvableRequest> = {}): ResolvableRequest {
  return { headers: {}, path: '/api/admin/x', ...overrides }
}

function strategy(
  name: string,
  result: string | null,
  serverIssued = false,
): TenantResolverStrategy {
  return {
    name,
    serverIssued,
    resolve: vi.fn(async () => (result === null ? null : { tenantId: result })),
  }
}

describe('TenantResolverChain', () => {
  it('第一个命中的赢，后面的策略一次都不被调用', async () => {
    const first = strategy('token', 'T-FROM-TOKEN')
    const second = strategy('slug-header', 'T-FROM-SLUG')
    const third = strategy('subdomain', 'T-FROM-HOST')

    const chain = new TenantResolverChain([first, second, third])
    const hit = await chain.resolve(req())

    expect(hit).toEqual({ tenantId: 'T-FROM-TOKEN', by: 'token' })
    // 这条断言就是「token 已给 tenantId 则忽略后续策略」的机器守卫。
    expect(second.resolve).not.toHaveBeenCalled()
    expect(third.resolve).not.toHaveBeenCalled()
  })

  it('前面的不适用就往后走', async () => {
    const chain = new TenantResolverChain([
      strategy('token', null),
      strategy('slug-header', 'T-FROM-SLUG'),
      strategy('subdomain', 'T-FROM-HOST'),
    ])
    expect(await chain.resolve(req())).toEqual({ tenantId: 'T-FROM-SLUG', by: 'slug-header' })
  })

  it('全都不适用时返回 null（由中间件决定失败关闭）', async () => {
    const chain = new TenantResolverChain([strategy('a', null), strategy('b', null)])
    expect(await chain.resolve(req())).toBeNull()
  })

  it('order 反映的就是注册顺序', () => {
    const chain = new TenantResolverChain([strategy('a', null), strategy('b', null)])
    expect(chain.order).toEqual(['a', 'b'])
  })

  // ── serverIssuedOnly：TENANT_TOKEN_ONLY_PREFIXES 的实现基础 ────────────────
  it('serverIssuedOnly 时，客户端可控的策略一次都不被调用', async () => {
    const token = strategy('token', null, true)
    const slug = strategy('slug-header', 'T-FROM-SLUG')
    const chain = new TenantResolverChain([token, slug])

    const hit = await chain.resolve(req(), { serverIssuedOnly: true })

    // 关键：不是「跑了但忽略结果」，是压根不跑——不跑就不会多一次 DB 查询。
    expect(hit).toBeNull()
    expect(token.resolve).toHaveBeenCalledTimes(1)
    expect(slug.resolve).not.toHaveBeenCalled()
  })

  it('serverIssuedOnly 时 token 策略照常生效', async () => {
    const chain = new TenantResolverChain([
      strategy('token', 'T-FROM-TOKEN', true),
      strategy('slug-header', 'T-FROM-SLUG'),
    ])
    expect(await chain.resolve(req(), { serverIssuedOnly: true })).toEqual({
      tenantId: 'T-FROM-TOKEN',
      by: 'token',
    })
  })

  it('没标 serverIssued 的策略默认按「客户端可控」对待（保守）', async () => {
    // 下游自己写的策略忘了标记时，宁可在 token-only 前缀下不生效，
    // 也不要默认让一个来路不明的来源能决定当前店铺。
    const custom = strategy('custom', 'T-CUSTOM')
    const chain = new TenantResolverChain([custom])
    expect(await chain.resolve(req(), { serverIssuedOnly: true })).toBeNull()
    expect(custom.resolve).not.toHaveBeenCalled()
  })
})

describe('免租户前缀', () => {
  it('清单就是蓝图 §4.1 写死的那两个', () => {
    expect([...TENANT_FREE_PREFIXES]).toEqual(['/api/public', '/api/platform'])
  })

  it.each([
    ['/api/public', true],
    ['/api/public/register', true],
    ['/api/platform/tenants', true],
    ['/api/publicity/x', false],
    ['/api/platformish', false],
    ['/api/admin/goods', false],
    ['/api/client/home', false],
  ])('%s → 免租户 %s', (path, expected) => {
    expect(isTenantFreePath(path)).toBe(expected)
  })

  it('requestPath 会剥掉 query string', () => {
    expect(requestPath(req({ path: undefined, url: '/api/public/x?a=1' }))).toBe('/api/public/x')
  })
})

describe('只认 token 的前缀（TENANT_TOKEN_ONLY_PREFIXES）', () => {
  it('清单目前只有 /api/admin', () => {
    expect([...TENANT_TOKEN_ONLY_PREFIXES]).toEqual(['/api/admin'])
  })

  it.each([
    ['/api/admin', true],
    ['/api/admin/goods', true],
    ['/api/administrator/x', false],
    ['/api/client/goods', false],
    ['/api/public/signup', false],
  ])('%s → 只认 token %s', (path, expected) => {
    expect(isTokenOnlyTenantPath(path)).toBe(expected)
  })

  it('与免租户清单互不重叠——一条路径不能既「不解析」又「只用 token 解析」', () => {
    for (const prefix of TENANT_TOKEN_ONLY_PREFIXES) {
      expect(isTenantFreePath(prefix)).toBe(false)
    }
  })
})

// ── 非 /api 路径：修复 /health、/docs 被误判为「店铺不存在」的那道更根本的规则 ──
describe('isApiPath：租户解析只对 /api/* 有意义', () => {
  it.each([
    ['/api', true],
    ['/api/public', true],
    ['/api/admin/goods', true],
    ['/health', false],
    ['/docs', false],
    ['/docs-json', false],
    ['/docs-yaml', false],
    ['/', false],
    ['/apix', false], // 前缀相似但不是 /api/ 或 /api 本身，不能被字符串前缀误判命中
  ])('%s → 是 /api 路径 %s', (path, expected) => {
    expect(isApiPath(path)).toBe(expected)
  })

  it('NON_API_FRAMEWORK_PREFIXES 里的每一条都确实落在非 /api 规则下（文档与实现不脱节）', () => {
    for (const prefix of NON_API_FRAMEWORK_PREFIXES) {
      expect(isApiPath(prefix), `${prefix} 应该被 isApiPath 判为 false`).toBe(false)
    }
  })
})

describe('TenantMiddleware：/health、/docs 这类非 /api 路径直接放行，解析链一次都不跑', () => {
  function fakeChain(result: { tenantId: string } | null = null): TenantResolverChain {
    return {
      resolve: vi.fn(async () => result),
    } as unknown as TenantResolverChain
  }

  async function run(
    middleware: TenantMiddleware,
    path: string,
  ): Promise<{ next: ReturnType<typeof vi.fn> }> {
    const next = vi.fn()
    await middleware.use(
      req({ path }) as unknown as Parameters<TenantMiddleware['use']>[0],
      {} as unknown as Parameters<TenantMiddleware['use']>[1],
      next,
    )
    return { next }
  }

  it.each(['/health', '/docs', '/docs-json', '/docs-yaml', '/'])(
    '%s：next() 被无错调用一次，且解析链一次都不被调用',
    async (path) => {
      const chain = fakeChain()
      const middleware = new TenantMiddleware(chain)
      const { next } = await run(middleware, path)

      expect(chain.resolve).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith()
    },
  )

  it('对照组：/api/client/x 这种正常业务路径仍然会跑解析链（不是所有路径都被放行）', async () => {
    // 命中之后中间件还会 patchCurrentContext（要求已经在 ALS 上下文里），
    // 这里只关心「链有没有被跑」，不起一份 runWithContext 也不影响这条断言。
    const chain = fakeChain({ tenantId: 'T1' })
    const middleware = new TenantMiddleware(chain)
    await run(middleware, '/api/client/x')

    expect(chain.resolve).toHaveBeenCalledTimes(1)
  })
})

describe('spec 16：AuthModule 的 exclude 必须用常量而不是手抄', () => {
  const source = readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), '..', 'auth.module.ts'),
    'utf8',
  )

  it('configure() 里 exclude 的入参来自 TENANT_FREE_PREFIXES', () => {
    expect(source).toMatch(/\.exclude\(/)
    expect(source).toContain('TENANT_FREE_PREFIXES.flatMap')
  })

  it('auth.module.ts 里没有硬编码的免租户前缀字面量', () => {
    // 手抄一份字符串是这类 bug 的经典源头：改了常量、忘了改抄件。
    expect(source).not.toContain("'/api/public'")
    expect(source).not.toContain("'/api/platform'")
  })

  it('中间件自己也再判一次（装配被改坏时的第二道）', () => {
    const middleware = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'tenant.middleware.ts'),
      'utf8',
    )
    expect(middleware).toContain('isTenantFreePath')
  })

  it('中间件的 token-only 分支也来自常量，不是手抄的前缀字面量', () => {
    const middleware = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'tenant.middleware.ts'),
      'utf8',
    )
    expect(middleware).toContain('isTokenOnlyTenantPath')
    expect(middleware).not.toContain("'/api/admin'")
  })

  it('中间件对 /health /docs 的放行用的是 isApiPath 这条规则，不是手抄的 /health /docs 字面量', () => {
    // 回归守卫：这次事故的修法就是「非 /api 路径一律放行」，而不是往某份清单里
    // 追加 '/health' '/docs' 两个字符串——后者明天来一条新框架路由又会重演同一个事故。
    const middleware = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'tenant.middleware.ts'),
      'utf8',
    )
    expect(middleware).toContain('isApiPath')
    expect(middleware).not.toContain("'/health'")
    expect(middleware).not.toContain("'/docs'")
  })
})
