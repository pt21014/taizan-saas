/**
 * 蓝图 §8 **spec 16**：租户中间件的 `forRoutes` / `exclude` 与真实控制器前缀比对。
 *
 * 守的不变量：**注册时店铺还不存在，中间件失败关闭会 500**（knowledge 上的真实事故：
 * `/api/public/signup` 被租户中间件挡成 404，用户根本注册不进来）。
 *
 * 本应用有四条一级命名空间，每一条的租户解析口径**必须是想清楚了的**，而不是「碰巧」：
 *
 * | 前缀 | 进中间件？ | 解析不到时 | 为什么 |
 * |---|---|---|---|
 * | `/api/public` | 否 | —— | 注册时店铺还不存在 |
 * | `/api/platform` | 否 | —— | 平台超管天然跨租户，给它一个 tenantId 反而会「看不到数据」 |
 * | `/api/admin` | 是，**只认 token** | 留空放行 → 守卫报 1140100 | 没带 token 是「未登录」，不是「店铺不存在」 |
 * | `/api/client` | 是，全链 | **失败关闭** 1240400 | C 端登录前就靠 slug 选店，解析不出来就是真没这家店 |
 *
 * 冒出第五条命名空间时这份 spec 会红——那正是需要有人停下来想一想的时刻。
 */

import {
  isTenantFreePath,
  isTokenOnlyTenantPath,
  TENANT_FREE_PREFIXES,
  TENANT_TOKEN_ONLY_PREFIXES,
} from '@taizan/nest-auth'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { API_NAMESPACES } from '../../src/tenancy/resolver.config'
import { APP_ROOT, blankCommentsAndStrings, readSources, SRC_DIR } from './_helpers'

/** 从所有控制器里抠出 `@Controller('...')` 的前缀。 */
function controllerPrefixes(): string[] {
  const files = readSources(SRC_DIR, (p) => p.endsWith('.controller.ts'))
  const prefixes = new Set<string>()
  for (const file of files) {
    for (const match of file.source.matchAll(/@Controller\(\s*['"`]([^'"`]*)['"`]/g)) {
      const raw = match[1] ?? ''
      prefixes.add(raw.startsWith('/') ? raw : `/${raw}`)
    }
  }
  return [...prefixes].sort()
}

const prefixes = controllerPrefixes()

/** 一个控制器前缀归哪条命名空间。 */
function namespaceOf(prefix: string): string | undefined {
  return API_NAMESPACES.find((ns) => prefix === ns || prefix.startsWith(`${ns}/`))
}

describe('spec 16：租户中间件的适用范围与控制器前缀比对', () => {
  it('真的扫到了控制器前缀', () => {
    expect(prefixes.length).toBeGreaterThanOrEqual(6)
    expect(prefixes.every((p) => p.startsWith('/api/'))).toBe(true)
  })

  it('每个控制器前缀都落在四条已知命名空间里', () => {
    const orphans = prefixes.filter((p) => namespaceOf(p) === undefined)
    expect(
      orphans,
      '这些控制器开了一条新的一级命名空间。它该不该进租户中间件？失败时该报 401 还是 404？\n' +
        '想清楚之后把它加进 src/tenancy/resolver.config.ts 的 API_NAMESPACES，' +
        '并在 @taizan/nest-auth 的 TENANT_FREE_PREFIXES / TENANT_TOKEN_ONLY_PREFIXES 里表态。',
    ).toEqual([])
  })

  it('四条命名空间每一条都真的有控制器（清单里躺着一条空的 = 没人维护的死约定）', () => {
    for (const ns of API_NAMESPACES) {
      expect(
        prefixes.some((p) => namespaceOf(p) === ns),
        `${ns} 下一个控制器都没有`,
      ).toBe(true)
    }
  })

  it('/api/public 与 /api/platform 免租户；/api/admin 与 /api/client 不免', () => {
    expect([...TENANT_FREE_PREFIXES]).toEqual(['/api/public', '/api/platform'])
    for (const prefix of prefixes) {
      const free = isTenantFreePath(prefix)
      const ns = namespaceOf(prefix)
      expect(free, `${prefix} 的免租户判定`).toBe(ns === '/api/public' || ns === '/api/platform')
    }
  })

  it('/api/admin 只认 token（且解析不到时留空，不报 1240400）', () => {
    expect([...TENANT_TOKEN_ONLY_PREFIXES]).toEqual(['/api/admin'])
    for (const prefix of prefixes) {
      expect(isTokenOnlyTenantPath(prefix), `${prefix} 的 token-only 判定`).toBe(
        namespaceOf(prefix) === '/api/admin',
      )
    }
  })

  it('/api/client 走完整解析链且失败关闭（既不免租户、也不是 token-only）', () => {
    const clientPrefixes = prefixes.filter((p) => namespaceOf(p) === '/api/client')
    expect(clientPrefixes.length).toBeGreaterThan(0)
    for (const prefix of clientPrefixes) {
      expect(isTenantFreePath(prefix)).toBe(false)
      expect(isTokenOnlyTenantPath(prefix)).toBe(false)
    }
  })

  it('/api/public/signup* 一定不进租户中间件（T1-8：注册时这家店还不存在）', () => {
    // knowledge 上真实发生过的事故：`/api/public/signup` 被租户中间件挡成 404，
    // 用户根本注册不进来——而中间件是**失败关闭**的，它按 slug 找租户，
    // 而注册请求里那个 slug 恰恰是「还不存在、正要被创建的那一个」。
    // 单拎出来断言而不是靠上面那条通配：`/api/public` 免租户是一句一般规则，
    // 而这条路径是那条规则**唯一一个有过事故的具体案例**，值得被点名钉住。
    for (const path of [
      '/api/public/signup',
      '/api/public/signup/check-slug',
      '/api/public/signup/captcha',
      '/api/public/site-config',
    ]) {
      expect(isTenantFreePath(path), `${path} 必须免租户`).toBe(true)
      expect(isTokenOnlyTenantPath(path), `${path} 不该走 token-only 解析`).toBe(false)
    }
  })

  it('自助注册的控制器前缀确实被扫到了（改了目录名要这条先红，而不是上面那条静默通过）', () => {
    expect(prefixes).toContain('/api/public/signup')
    expect(prefixes.filter((p) => namespaceOf(p) === '/api/public').length).toBeGreaterThanOrEqual(
      2,
    )
  })

  it('两份清单互不重叠——一条路径不能既「不解析」又「只用 token 解析」', () => {
    for (const p of TENANT_TOKEN_ONLY_PREFIXES) {
      expect(isTenantFreePath(p)).toBe(false)
    }
    for (const p of TENANT_FREE_PREFIXES) {
      expect(isTokenOnlyTenantPath(p)).toBe(false)
    }
  })
})

describe('装配没有手抄一份前缀清单', () => {
  const appModule = readFileSync(join(APP_ROOT, 'src', 'bootstrap', 'app.module.ts'), 'utf8')
  const resolverConfig = readFileSync(
    join(APP_ROOT, 'src', 'tenancy', 'resolver.config.ts'),
    'utf8',
  )

  it('app.module.ts 没有硬编码免租户前缀（exclude 由 AuthModule 用常量做）', () => {
    const code = blankCommentsAndStrings(appModule)
    expect(code).not.toContain('/api/public')
    expect(code).not.toContain('/api/platform')
  })

  it('resolver.config.ts 直接 re-export 框架常量，而不是复制值', () => {
    expect(resolverConfig).toContain("from '@taizan/nest-auth'")
    expect(resolverConfig).toContain('TENANT_FREE_PREFIXES')
    expect(resolverConfig).toContain('TENANT_TOKEN_ONLY_PREFIXES')
  })

  it('AuthModule 的租户中间件没被关掉', () => {
    // `registerTenantMiddleware: false` 会让整条租户解析静默消失：
    // 上下文里永远没有 tenantId，于是每一次 prisma.tenant 查询都抛 NO_CONTEXT。
    const code = blankCommentsAndStrings(appModule)
    expect(code).not.toMatch(/registerTenantMiddleware\s*:\s*false/)
  })

  it('全局守卫由应用一处装（AuthModule 自己不挂）', () => {
    const code = blankCommentsAndStrings(appModule)
    expect(
      code,
      'registerGlobalGuard 必须显式为 false，守卫顺序在 global-providers.ts 定死',
    ).toMatch(/registerGlobalGuard\s*:\s*false/)
  })
})
