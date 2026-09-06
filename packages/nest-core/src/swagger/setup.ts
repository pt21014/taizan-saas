import type { INestApplication } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

/** {@link setupSwagger} 的选项。 */
export interface SwaggerSetupOptions {
  /** 文档标题，例如 `taizan-saas API` */
  title: string
  /** 版本号 */
  version: string
  /** 挂载路径，默认 `docs` */
  path?: string
  /** 描述 */
  description?: string
  /**
   * 是否开启。不传时按「生产默认关，其余默认开」计算，并允许 `SWAGGER_ENABLED=1` 在生产强开。
   * 生产默认关是因为 Swagger 会把全部路由、DTO 字段、校验规则完整暴露出去——
   * 这是一份免费的攻击面清单。
   */
  enabled?: boolean
  /** Bearer 认证的 scheme 名，默认 `bearer`；传 null 不加认证配置。 */
  bearerAuthName?: string | null
}

/** 按 env 计算 Swagger 默认开关。 */
export function isSwaggerEnabledByEnv(
  env: { NODE_ENV?: string; SWAGGER_ENABLED?: boolean } = process.env as {
    NODE_ENV?: string
  },
): boolean {
  if (env.SWAGGER_ENABLED === true) {
    return true
  }
  return env.NODE_ENV !== 'production'
}

/**
 * 装配 Swagger。返回是否真的挂上了——`main.ts` 里可以据此决定要不要打印文档地址。
 */
export function setupSwagger(app: INestApplication, options: SwaggerSetupOptions): boolean {
  const {
    title,
    version,
    path = 'docs',
    description = '',
    enabled = isSwaggerEnabledByEnv(),
    bearerAuthName = 'bearer',
  } = options

  if (!enabled) {
    return false
  }

  let builder = new DocumentBuilder().setTitle(title).setVersion(version)
  if (description) {
    builder = builder.setDescription(description)
  }
  if (bearerAuthName) {
    builder = builder.addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      bearerAuthName,
    )
  }

  const document = SwaggerModule.createDocument(app, builder.build())
  SwaggerModule.setup(path, app, document, {
    swaggerOptions: { persistAuthorization: true },
  })
  return true
}
