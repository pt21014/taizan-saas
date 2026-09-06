/**
 * 蓝图 §8 **spec 5**：每个路由要么被全局守卫覆盖（默认拒绝），要么显式 `@Public()`；
 * 且 `@Public()` 的路由必须同时声明 `@RateLimited(tier)`。
 *
 * 守的不变量：**新控制器忘写守卫的默认结果是「拒绝」**（xiaodian 的第 1 条约定）。
 *
 * 运行时那一半已经由 `GlobalAuthGuard`（`APP_GUARD`）保证了。这里守的是另一半——
 * 那些运行时最多打条 warn、而 warn 在 CI 上没人看的事：
 *
 * - **公开路由没限流** = 一个免费的爆破入口。登录接口尤其致命：没有限流的
 *   `POST /api/admin/auth/login` 等于把所有商家的口令交给一台跑字典的机器。
 * - **`@UseGuards()` 换掉全局守卫** = 悄悄给自己开了后门。
 *
 * 扫描器用的是 `@taizan/nest-auth` 导出的 `scanControllerSources`——**不在下游重抄一份**，
 * 那样两边的正则会慢慢走偏。它自带哨兵（`SENTINEL_SOURCE`），正则失效时哨兵先炸。
 */

import { scanControllerSources, SENTINEL_EXPECTATION, SENTINEL_SOURCE } from '@taizan/nest-auth'
import { RATE_LIMIT_TIER_NAMES } from '@taizan/ratelimit-core'
import { describe, expect, it } from 'vitest'

import { readSources, SRC_DIR } from './_helpers'

const controllers = readSources(SRC_DIR, (path) => path.endsWith('.controller.ts'))
const report = scanControllerSources(controllers.map((f) => ({ path: f.path, source: f.source })))

describe('spec 5：默认拒绝 + 公开路由必须限流', () => {
  it('哨兵：扫描器本身没坏（扫不到东西和没有问题长得一模一样）', () => {
    const sentinel = scanControllerSources([{ path: 'sentinel.ts', source: SENTINEL_SOURCE }])
    expect(sentinel.routes).toHaveLength(SENTINEL_EXPECTATION.routeCount)
    expect(sentinel.violations).toHaveLength(SENTINEL_EXPECTATION.violationCount)
    expect(sentinel.violations[0]?.route.method).toBe(SENTINEL_EXPECTATION.violatingMethod)
  })

  it('真的扫到了控制器（一个都没扫到会让下面全绿）', () => {
    expect(controllers.length).toBeGreaterThanOrEqual(6)
    expect(report.routes.length).toBeGreaterThanOrEqual(12)
  })

  it('零违规', () => {
    expect(
      report.violations.map((v) => v.message),
      '公开路由是主动开的洞，没有限流的洞就是免费的爆破入口。',
    ).toEqual([])
  })

  it('每个 @Public() 路由都声明了限流档位', () => {
    const publicRoutes = report.routes.filter((r) => r.isPublic)
    expect(publicRoutes.length, '一个公开路由都没有？登录接口必然是公开的').toBeGreaterThan(0)
    for (const route of publicRoutes) {
      expect(
        route.rateLimitTier,
        `${route.file} 的 ${route.controller}.${route.method} 是 @Public() 但没有 @RateLimited`,
      ).toBeTruthy()
    }
  })

  it('每个 @RateLimited(tier) 用的都是 RATE_LIMIT_TIER_NAMES 里的合法档位名', () => {
    // 拼错的档位名不会让接口不限流（RateLimitService.resolveTier 会退回兜底档并 warn），
    // 但那意味着这条路由用错了阈值——而 warn 在 CI 上没人看。这条只能静态查。
    const withTier = report.routes.filter((r) => r.rateLimitTier !== undefined)
    expect(
      withTier.length,
      '一个用了 @RateLimited 的路由都没有？上面几条断言应该已经扫到了',
    ).toBeGreaterThan(0)
    for (const route of withTier) {
      expect(
        RATE_LIMIT_TIER_NAMES,
        `${route.file} 的 ${route.controller}.${route.method} 用了 @RateLimited(` +
          `'${route.rateLimitTier}')，不是内置档位。请对照 RATE_LIMIT_TIER_NAMES 改正` +
          `（例如 'public-read' 不存在，公开只读接口该用 'public-default' 或 'lookup'）。`,
      ).toContain(route.rateLimitTier)
    }
  })

  it('登录类公开路由用的是 login 档，不是 public-read 档', () => {
    // 口令爆破与「刷一个公开的商品列表」不是一个量级的威胁，档位不该一样。
    const loginRoutes = report.routes.filter((r) => r.isPublic && /login/i.test(r.method))
    expect(loginRoutes.length).toBeGreaterThanOrEqual(2)
    for (const route of loginRoutes) {
      expect(route.rateLimitTier, `${route.controller}.${route.method} 的限流档位`).toBe('login')
    }
  })

  it('非公开路由占多数（默认拒绝的意思就是「大部分接口什么都不用写」）', () => {
    const guarded = report.routes.filter((r) => !r.isPublic)
    expect(guarded.length).toBeGreaterThan(report.routes.length / 2)
  })

  it('没有控制器用 @UseGuards() 顶替全局守卫', () => {
    // 换掉全局守卫本身不一定错（比如接一个第三方回调的签名校验），但那必须是
    // 一次显式的、被 review 看见的决定。目前一处都不该有。
    const overriding = controllers.filter((f) => /@UseGuards\s*\(/.test(f.source))
    expect(
      overriding.map((f) => f.path),
      '这些控制器用 @UseGuards() 换掉了全局守卫链。真要这么做请在这条 spec 里加白名单并写理由。',
    ).toEqual([])
  })

  it('每个 @Auth() 声明的身份都是三种之一', () => {
    for (const route of report.routes) {
      for (const kind of route.authKinds) {
        expect(['platform', 'staff', 'member']).toContain(kind)
      }
    }
  })

  it('三个命名空间的控制器都声明了身份（@Auth 或 @Public，二选一）', () => {
    // 「什么都不写」运行时是 401（安全），但那通常意味着作者没想清楚这条路由给谁用。
    const unspecified = report.routes.filter((r) => !r.isPublic && r.authKinds.length === 0)
    expect(
      unspecified.map((r) => `${r.file}  ${r.controller}.${r.method}`),
      '这些路由既没有 @Public() 也没有 @Auth(kind)。运行时它们是「任何一种有效 token 都能进」——' +
        '也就是 member token 能打商家后台。请显式声明身份。',
    ).toEqual([])
  })
})
