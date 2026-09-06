/**
 * 租户解析策略（蓝图 §4.1）。
 *
 * @packageDocumentation
 */

import type { RequestWithPrincipal } from '../principal'

/** 解析器看到的请求切片。刻意只暴露这些字段——多给一个 `body` 就会有人拿它取 tenantId。 */
export type ResolvableRequest = RequestWithPrincipal

/**
 * 一条租户解析策略。
 *
 * ## 三条约束
 *
 * 1. **有序**：链上第一个返回非 null 的赢，后面的不再执行。
 * 2. **失败关闭**：全部返回 null 时中间件抛 1240400，绝不「当作没有租户放过去」——
 *    放过去的后果是隔离扩展拿不到 tenantId 而在业务层某个更深的地方炸掉，
 *    或者更糟，某个忘了走 `prisma.tenant` 的查询把全租户的数据查出来了。
 * 3. **只读**：策略不许改请求，也不许写上下文。写上下文是 {@link TenantMiddleware} 的事，
 *    这样「谁写了 tenantId」就只有一处。
 */
export interface TenantResolverStrategy {
  /** 策略名，出现在日志与错误排查里。 */
  readonly name: string
  /**
   * 这条策略的租户来源是不是**服务端签发的凭证**（也就是我们自己签过名的 token）。
   *
   * 为什么需要这个标记而不是按 `name === 'token'` 判断：
   * {@link TENANT_TOKEN_ONLY_PREFIXES} 下只允许服务端签发的来源生效，而策略链是
   * 下游可以整条替换的（`AuthModule.forRoot({ tenantResolvers })`）。按名字硬判会在
   * 下游给策略换个名字时**静默失效**——失效的方向恰好是「客户端可控的来源又能用了」。
   *
   * 缺省 `false`（保守）：请求头、Host、query 这些客户端能随手填的来源一律不算。
   */
  readonly serverIssued?: boolean
  /**
   * 尝试解析。
   *
   * @returns 解析出的租户；本策略不适用（比如路径不匹配、头不存在）返回 `null`
   */
  resolve(req: ResolvableRequest): Promise<{ tenantId: string } | null>
}

/**
 * 不进租户中间件的路径前缀。
 *
 * - `/api/public/*`：自助注册、找回密码、扫码进店前的落地页——**这时候店铺还不存在**，
 *   或者请求方压根还没选店。中间件失败关闭会把注册页变成 404，
 *   而那正是 knowledge 上真实发生过的事故（蓝图 spec 16 的守护对象）。
 * - `/api/platform/*`：平台超管天然跨租户，给它解析一个 tenantId 反而会让
 *   `prisma.tenant` 悄悄把查询限制在某一家店，平台后台会看到「数据不见了」。
 *
 * 这个常量同时是 `AuthModule.configure()` 的 `exclude()` 入参和 spec 16 的比对基准，
 * **一处定义两处用**——分别写死两份是这类 bug 的经典源头。
 */
export const TENANT_FREE_PREFIXES: readonly string[] = ['/api/public', '/api/platform'] as const

/**
 * 「只认服务端签发的租户来源，且**解析不到也不抛错**」的路径前缀。
 *
 * ## 为什么 `/api/admin` 必须在这里
 *
 * 中间件跑在守卫**之前**（Nest 的执行顺序：middleware → guard → interceptor → handler）。
 * `/api/admin/*` 没带 token 或带了个坏 token 时，租户解析链三条策略全都不适用，
 * 中间件一失败关闭就抛 `1240400`（租户不存在）——可这明明是一次**未登录**，
 * 正确答案是 `1140100`。前端拿到 1240400 会去提示「店铺不存在」而不是跳登录页，
 * 用户就卡在那里了。
 *
 * 所以这些前缀下的规则是：
 * 1. 只跑 `serverIssued` 的策略（也就是 {@link TokenTenantResolver}）——
 *    商家后台的店铺**只能**由 token 决定，`X-Tenant-Slug` / 子域名在这里一概不作数；
 * 2. 解析不出来就**留空**放行，让 `GlobalAuthGuard` 去报 1140100。
 *
 * ## 这不是把失败关闭改成了失败开放
 *
 * 留空 ≠ 放行到业务。上下文里没有 `tenantId`，任何走 `prisma.tenant` 的租户域查询都会
 * 抛 `TenantScopeError('NO_CONTEXT')`；而在那之前 `GlobalAuthGuard` 已经先 401 了。
 * 真正被去掉的只有「在守卫之前抢着报一个错误的错误码」这件事。
 *
 * 反过来 `/api/client/*` **保持失败关闭**：C 端在用户登录前就要靠 slug / 子域名选店，
 * 那里解析不出来就是真的「这家店不存在」，1240400 是对的。
 */
export const TENANT_TOKEN_ONLY_PREFIXES: readonly string[] = ['/api/admin'] as const

/**
 * 业务 API 的路径前缀。租户解析——连同它整套「有序 / 失败关闭 / token-only」的
 * 语义——只对这个前缀下的路径有意义。
 *
 * ## 这是这次 `/health` `/docs` 事故的根因，也是修法
 *
 * `TenantMiddleware` 曾经只靠 {@link TENANT_FREE_PREFIXES}（`exclude()` 的白名单）
 * 决定放不放行；那份清单天然只会有人往里填 `/api/*` 下的东西，因为写它的人想的是
 * 「四条业务命名空间里哪条不用解析租户」，根本不会想到框架自己挂的 `/health`、
 * Swagger 的 `/docs`——这些路由不属于任何一条命名空间，讨论免租户前缀时没人会想起它们。
 * 于是它们落进了「既不在免租户清单、也不在 token-only 清单」的默认分支：**失败关闭**，
 * 探活拿到 HTTP 200 + 业务码 1240400，而不是健康报告；线上按状态码摘流量的探活因此失效。
 *
 * 治本的做法不是往 {@link TENANT_FREE_PREFIXES} 里加 `/health`、`/docs`——那只是把
 * 同一个漏洞搬到下一个框架路由上（明天来一个 `/metrics` 又得手抄一条）。真正成立的规则是
 * **反过来的**：租户解析这件事只对 `/api/*` 有意义，`/api/` 之外的任何路径——现在的
 * `/health` `/docs`，以后随便加的框架路由——都不该被拖进来。{@link isApiPath} 就是
 * 这条规则本身；`TenantMiddleware.use()` 拿它做的检查排在 {@link isTenantFreePath} 之前，
 * 且不依赖任何一份手抄的路径清单。
 */
export const API_PATH_PREFIX = '/api'

/** 这条路径是否落在 {@link API_PATH_PREFIX} 下（`/api` 本身，或 `/api/...`）。 */
export function isApiPath(path: string): boolean {
  return path === API_PATH_PREFIX || path.startsWith(`${API_PATH_PREFIX}/`)
}

/**
 * 目前已知、会被 {@link isApiPath} 取反规则放行的框架路由前缀。
 *
 * **不参与任何判断逻辑**——放行与否只看 `isApiPath`。这份清单纯粹是文档：
 * 把「我们已经想清楚了这些路由不该进租户中间件」这件事显式写出来，
 * 好让 spec 一眼看出「这不是漏判，是表过态的」，而不是靠读一遍 `isApiPath` 的实现反推。
 * 冒出一个新的非 API 框架路由时，它自动被 `isApiPath` 放行——不用先加进这份清单；
 * 加不加只影响这里的可读性，不影响行为。
 */
export const NON_API_FRAMEWORK_PREFIXES: readonly string[] = [
  '/health',
  '/docs',
  '/docs-json',
  '/docs-yaml',
] as const

/** 取请求路径（去掉 query string）。express 5 下 `req.path` 一般都有，兜底解析 url。 */
export function requestPath(req: ResolvableRequest): string {
  if (typeof req.path === 'string' && req.path.length > 0) return req.path
  const raw = req.originalUrl ?? req.url ?? ''
  const q = raw.indexOf('?')
  return q === -1 ? raw : raw.slice(0, q)
}

/** 这条路径是否免租户。 */
export function isTenantFreePath(path: string): boolean {
  return TENANT_FREE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/** 这条路径是否属于 {@link TENANT_TOKEN_ONLY_PREFIXES}（只认 token、解析不到不抛错）。 */
export function isTokenOnlyTenantPath(path: string): boolean {
  return TENANT_TOKEN_ONLY_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  )
}

/** 取单值请求头（express 的头值可能是数组）。 */
export function headerValue(req: ResolvableRequest, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
