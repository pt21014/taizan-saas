/**
 * 应用级装配：helmet / CORS / Swagger / trust proxy / 优雅停机。
 *
 * ## 为什么单独一个文件而不是写在 `main.ts` 里
 *
 * 这些配置必须拿到 `INestApplication` 实例才能做，所以它们进不了模块。但如果只写在
 * `main.ts` 里，`test/tenant-isolation.e2e-spec.ts` 起的那个 app 就**没有**它们——
 * 于是 e2e 全绿，而线上跑的是另一个配置不同的 app。「Swagger 在 dev 可访问」这条
 * 用例尤其明显：它测的是 `main.ts` 的行为，测试里却根本没调过 `setupSwagger`。
 *
 * 抽成一个函数之后，`main.ts` 与 e2e 调的是**同一段代码**。
 *
 * @packageDocumentation
 */

import type { INestApplication } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { applyCors, applyHelmet, ConfigService, setupSwagger } from '@taizan/nest-core'

import type { AppEnv } from '../config/env'

/** {@link configureApp} 的产出，`main.ts` 用它决定要不要打印文档地址。 */
export interface ConfigureAppResult {
  swaggerEnabled: boolean
  port: number
}

/**
 * 把应用级配置全部装上。
 *
 * @param app - `NestFactory.create()` / `moduleRef.createNestApplication()` 的产物
 * @returns 见 {@link ConfigureAppResult}
 */
export function configureApp(app: INestApplication): ConfigureAppResult {
  const config = app.get<ConfigService<AppEnv>>(ConfigService)

  // `X-Forwarded-For` 必须可信才有意义：`resolveIps` 从末尾倒数 TRUSTED_PROXY_HOPS 跳
  // 取真实客户端 IP，而 express 得先被告知自己在反代后面。配错等于限流可被伪造绕过。
  ;(app as NestExpressApplication).set('trust proxy', config.get('TRUSTED_PROXY_HOPS'))

  applyHelmet(app)
  applyCors(app, config.get('CORS_ORIGINS'), { isProduction: config.isProduction })

  const swaggerEnabled = setupSwagger(app, {
    title: `${config.get('APP_NAME')} API`,
    version: '0.1.0',
    path: 'docs',
    description:
      '三命名空间：/api/platform（平台超管）、/api/admin（商家后台）、/api/client（C 端）；' +
      '外加 /api/public（免登录免租户）。响应一律是 { code, message, data } 信封，' +
      'code=0 成功，非 0 见 @taizan/contracts 的 7 位错误码。',
  })

  // 收到 SIGTERM 时先把连接池、Redis 关干净（`onModuleDestroy` 会被调用）。
  // 不开这个的话 PM2 reload 会留下一堆半死的连接。
  app.enableShutdownHooks()

  return { swaggerEnabled, port: config.get('API_PORT') }
}
