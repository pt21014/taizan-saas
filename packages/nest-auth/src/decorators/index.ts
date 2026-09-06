/**
 * 路由级声明：`@Public()` / `@Auth()` / `@RateLimited()` / `@CurrentUser()`。
 *
 * ## 一个约定：metadata key 全部带 `taizan:auth:` 前缀
 *
 * `SetMetadata('isPublic', true)` 这种裸字符串会和任何一个也叫 `isPublic` 的第三方装饰器
 * 撞车，而撞车的表现是「某个路由莫名其妙变成公开的」——最坏的那种 bug。加前缀之后
 * 撞车概率归零，且 grep 一个前缀就能列出全仓所有认证声明（spec 5 就靠这个）。
 *
 * @packageDocumentation
 */

import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common'
import type { AuthPrincipal } from '../principal'
import { TOKEN_KINDS, type TokenKind } from '../token/jwt-payload'

/** `@Public()` 的 metadata key。 */
export const IS_PUBLIC_KEY = 'taizan:auth:public'

/** `@Auth()` 的 metadata key。 */
export const AUTH_KINDS_KEY = 'taizan:auth:kinds'

/** `@RateLimited()` 的 metadata key。 */
export const RATE_LIMIT_KEY = 'taizan:auth:rate-limit'

/**
 * 显式声明这个路由（或整个控制器）**不需要登录**。
 *
 * 全局守卫是默认拒绝的，所以「忘了写装饰器」的后果是 401 而不是裸奔——
 * 这正是 xiaodian 那条约定的价值（蓝图 §9）。反过来，公开路由是**主动开的洞**，
 * 必须同时用 {@link RateLimited} 声明限流档位，否则它就是一个免费的爆破入口。
 * `GlobalAuthGuard` 见到没有档位的 `@Public()` 会打一条 warn，spec 5 会把它升级成 CI 失败。
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true)

/**
 * 声明这个路由接受哪几种身份。
 *
 * 不写 `@Auth()` 时，任何一种有效 token 都能进（但仍然必须登录）。写了就只认列出的这些，
 * 其余的一律 1140102——例如 `@Auth('staff')` 的商家后台接口，拿 member token 打过来
 * 会明确地告诉前端「凭证类型不符」，而不是含糊的「未登录」。
 *
 * @param kinds - 接受的身份类型，至少一个
 */
export const Auth = (...kinds: TokenKind[]): MethodDecorator & ClassDecorator => {
  if (kinds.length === 0) {
    throw new TypeError('[@taizan/nest-auth] @Auth() 至少要声明一种身份；不限身份就别写这个装饰器')
  }
  for (const kind of kinds) {
    if (!TOKEN_KINDS.includes(kind)) {
      throw new TypeError(
        `[@taizan/nest-auth] @Auth() 收到未知身份 ${String(kind)}，合法值：${TOKEN_KINDS.join(' / ')}`,
      )
    }
  }
  return SetMetadata(AUTH_KINDS_KEY, kinds)
}

/**
 * 限流档位。**本包只写 metadata**——判定与档位表在 `@taizan/ratelimit-core`，
 * 执行在 `RateLimitGuard`（T2-6 已接线，装配见 `provideRateLimitGuard`）。
 *
 * 拆开的理由：档位是路由的**声明**（属于接口契约，和 `@Public()` 一起被 spec 5 检查），
 * 而限流算法是**实现**（要 Redis、要 `resolveIps`、要三维度）。
 *
 * 内置档位名见 `RATE_LIMIT_TIER_NAMES`：`login` / `sms-code` / `signup` / `lookup` /
 * `public-default`；业务项目用 `defineTier` 自己加。
 *
 * **档位名拼错不会让接口变成不限流**——守卫认不出的名字会退回 `public-default`
 * 并打一条 warn（真让它「不认识就放行」的话，打错一个字母就等于开了个后门）。
 *
 * @param tier - 档位名，语义由 `@taizan/ratelimit-core` 的档位表定义
 */
export const RateLimited = (tier: string): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, tier)

/**
 * 取当前登录主体。
 *
 * @example
 * ```ts
 * @Get('me')
 * @Auth('staff')
 * me(@CurrentUser() user: AuthPrincipal) { return user.staffId }
 * ```
 *
 * 传字段名可以只取一个字段：`@CurrentUser('tenantId') tenantId: string`。
 * 未登录（`@Public()` 路由）时返回 `undefined`，所以类型上要按可空处理。
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthPrincipal | undefined, ctx: ExecutionContext): unknown => {
    const req = ctx.switchToHttp().getRequest<{ principal?: AuthPrincipal }>()
    const principal = req.principal
    if (!principal) return undefined
    return field ? principal[field] : principal
  },
)
