import type { INestApplication } from '@nestjs/common'
import helmet, { type HelmetOptions } from 'helmet'

/**
 * 给应用装上 helmet 安全响应头。
 *
 * 默认**关掉 CSP**：这是一个纯 JSON API 进程，CSP 管的是浏览器如何加载页面资源，
 * 对 API 响应没有意义，但它会把 Swagger UI（同进程挂在 `/docs`）的内联脚本全部拦掉，
 * 结果就是文档页白屏。真要给同进程的 HTML 页面上 CSP，显式传 `contentSecurityPolicy` 覆盖。
 *
 * 反过来 `crossOriginResourcePolicy` 保持 helmet 默认的 `same-origin`——
 * 跨域访问由 CORS 白名单统一管，不在这里开口子。
 */
export function applyHelmet(app: INestApplication, options: HelmetOptions = {}): void {
  app.use(
    helmet({
      contentSecurityPolicy: false,
      ...options,
    }),
  )
}
