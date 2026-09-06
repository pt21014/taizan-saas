/**
 * 租户解析策略的装配（蓝图 §4.1）。
 *
 * 本应用**不替换**框架内置的三件套，只把根域配置传进去。这个文件存在的意义是：
 * 「租户是怎么被解析出来的」有一个应用侧可读的落点，而不是散在 `app.module.ts`
 * 的一个 `baseDomain:` 参数里。
 *
 * 内置顺序（`AuthModule` 默认，不能换）：
 *
 * ```
 * TokenTenantResolver   token.tenantId      最高优先，不可被请求参数覆盖
 *        ↓
 * SlugHeaderResolver    X-Tenant-Slug       仅 /api/client
 *        ↓
 * SubdomainResolver     {slug}.<根域>        C 端独立域名
 * ```
 *
 * 两条前缀不进中间件（{@link TENANT_FREE_PREFIXES}）：`/api/public`（注册时店铺还不存在）
 * 与 `/api/platform`（平台天然跨租户）。`/api/admin` 进中间件，但只用 token 策略且
 * **解析不到不抛错**——见 {@link TENANT_TOKEN_ONLY_PREFIXES} 的说明。
 *
 * @packageDocumentation
 */

import {
  TENANT_FREE_PREFIXES,
  TENANT_TOKEN_ONLY_PREFIXES,
  TENANT_SLUG_HEADER,
} from '@taizan/nest-auth'

/** 免租户中间件的前缀（框架常量，这里只是 re-export 让应用侧有一处可查）。 */
export { TENANT_FREE_PREFIXES, TENANT_TOKEN_ONLY_PREFIXES, TENANT_SLUG_HEADER }

/**
 * 本应用所有 `@Controller` 的一级命名空间。
 *
 * `test/arch/tenant-middleware.spec.ts`（spec 16）拿它跟实际控制器前缀比对：
 * 冒出一个不在这四条里的前缀，说明有人新开了一个命名空间却没想过它该不该进租户中间件。
 */
export const API_NAMESPACES = ['/api/platform', '/api/admin', '/api/client', '/api/public'] as const

/** 子域名解析的根域，来自 env `TENANT_BASE_DOMAIN`；不配就退化成「本策略不适用」。 */
export function resolveBaseDomain(env: { TENANT_BASE_DOMAIN?: string }): string | undefined {
  const raw = env.TENANT_BASE_DOMAIN?.trim()
  return raw && raw.length > 0 ? raw : undefined
}
