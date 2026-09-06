import type { INestApplication } from '@nestjs/common'

/** CORS 白名单为空且处于生产环境时抛出。 */
export class EmptyCorsWhitelistError extends Error {
  override readonly name = 'EmptyCorsWhitelistError'
  constructor() {
    super(
      'CORS_ORIGINS 为空：生产环境必须显式配置允许跨域的 Origin 白名单。' +
        '留空既不能真的关掉跨域（同源前端不受影响，但任何第三方页面都会被拒），' +
        '也不该退化成放行全部——请填上四端的实际域名，支持 https://*.example.com 通配。',
    )
  }
}

/**
 * 判断一条白名单规则是否命中某个 Origin。
 *
 * 支持两种写法：
 * - 精确匹配：`https://admin.example.com`
 * - 二级通配：`https://*.example.com` —— 只匹配**一级**子域（`a.example.com` 命中，
 *   `a.b.example.com` 不命中）。多级通配容易被 `evil.com#.example.com` 这类构造绕过，
 *   而且实际业务里也没有需要多级子域跨域的场景。
 *
 * 通配不跨协议：`https://*.example.com` 不会放行 `http://a.example.com`。
 */
export function matchOrigin(rule: string, origin: string): boolean {
  if (rule === origin) {
    return true
  }
  const starIndex = rule.indexOf('*')
  if (starIndex === -1) {
    return false
  }
  // 形如 `https://*.example.com`
  const prefix = rule.slice(0, starIndex)
  const suffix = rule.slice(starIndex + 1)
  if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) {
    return false
  }
  const middle = origin.slice(prefix.length, origin.length - suffix.length)
  // `*` 必须匹配到非空且不含 `.` 与 `/` 的一段（即恰好一级子域）。
  return middle.length > 0 && !middle.includes('.') && !middle.includes('/')
}

/** 本地开发放行的 Origin：任意端口的 localhost / 127.0.0.1 / [::1]。 */
const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/**
 * 构造一个 Origin 判定函数。
 *
 * @param origins - 白名单
 * @param isProduction - 生产环境。为 true 且白名单为空时抛 {@link EmptyCorsWhitelistError}
 */
export function createOriginChecker(
  origins: readonly string[],
  isProduction: boolean,
): (origin: string | undefined) => boolean {
  const list = origins.filter((o) => o.trim().length > 0)
  if (list.length === 0 && isProduction) {
    throw new EmptyCorsWhitelistError()
  }
  const allowLocalhost = list.length === 0 && !isProduction

  return (origin) => {
    // 同源请求、curl、服务端到服务端都没有 Origin 头——它们不受同源策略约束，放行。
    if (!origin) {
      return true
    }
    if (list.some((rule) => matchOrigin(rule, origin))) {
      return true
    }
    return allowLocalhost && LOCALHOST_PATTERN.test(origin)
  }
}

/**
 * 给应用装上 CORS。
 *
 * 白名单外的 Origin **不报错、只是不回 `Access-Control-Allow-Origin`**——
 * 浏览器自己会拦下来并给出标准的 CORS 报错，比我们回一个 500 更容易排查
 * （回 500 的话前端看到的是「服务器错误」，会去找后端；实际是域名没加白名单）。
 */
export function applyCors(
  app: INestApplication,
  origins: readonly string[],
  options: { isProduction?: boolean } = {},
): void {
  const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production'
  const isAllowed = createOriginChecker(origins, isProduction)
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, isAllowed(origin))
    },
    credentials: true,
    // 四端会带 tenant slug 与 traceId，预检必须允许，否则浏览器直接拦在 OPTIONS。
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Slug', 'X-Trace-Id'],
    exposedHeaders: ['X-Trace-Id'],
    maxAge: 600,
  })
}
