/**
 * 进程入口。
 *
 * 这里只剩三件事：查后门开关、建 app、监听端口。真正的应用级配置
 * （helmet / CORS / Swagger / trust proxy）在 {@link configureApp}——
 * 抽出去是为了让 e2e 起的 app 与线上跑的 app 是**同一份配置**，
 * 否则 e2e 全绿只能证明「另一个 app」是对的。
 *
 * 模块级装配（env、上下文、响应信封、日志、守卫）在 `app.module.ts`。
 *
 * @packageDocumentation
 */

// `reflect-metadata` 必须在任何装饰器被求值之前加载，所以它是整个进程的第一行。
import 'reflect-metadata'
// 本地开发从 `.env` 读配置。生产环境由 PM2 / 容器注入真实 env，`.env` 不存在时
// dotenv 静默跳过，不会报错。
import 'dotenv/config'

import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppLogger, ConfigService } from '@taizan/nest-core'

import { assertAppDevFlagsInProd, type AppEnv } from '../config/env'
import { AppModule } from './app.module'
import { configureApp } from './configure-app'

async function bootstrap(): Promise<void> {
  // 在建 app **之前**先查一遍应用级后门开关。框架级的那份由 `CoreModule.forRoot()`
  // 在装配时查，两份并列不合并（框架不认识业务新增的开关）。
  assertAppDevFlagsInProd(process.env)

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // 先缓冲日志，等下面 `useLogger` 换成 pino 之后再一起冲出来——
    // 否则启动阶段那几十行是 Nest 默认格式，没有 traceId、也不脱敏。
    bufferLogs: true,
    // **支付回调验签验的是原始字节**（`@taizan/nest-payment` README 的第一条装配要求）。
    // 关掉这一项之后 `req.rawBody` 是 undefined，`readRawCallback` 只剩下已经被
    // body-parser 解析过的对象——把它再 `JSON.stringify` 回来，键序与空白都对不上
    // 微信发过来的那串字节，于是**所有回调一律验签失败**：钱收到了，订单永远 PENDING，
    // 而且日志里看到的是「签名不匹配」这种指向攻击的误导性结论。
    // e2e 起 app 时（`moduleRef.createNestApplication`）也必须带上同一项。
    rawBody: true,
  })

  const logger = app.get(AppLogger)
  app.useLogger(logger)

  const { swaggerEnabled, port } = configureApp(app)
  await app.listen(port)

  const config = app.get<ConfigService<AppEnv>>(ConfigService)
  logger.log(
    `已启动：${config.get('API_BASE_URL')}（端口 ${port}，环境 ${config.get('NODE_ENV')}）` +
      `${swaggerEnabled ? '，Swagger 在 /docs' : '，Swagger 未开启'}`,
    'Bootstrap',
  )
}

void bootstrap()
