/**
 * `PrismaModule`：把 base client、`PrismaService`、`RawPrismaService` 接起来。
 *
 * @packageDocumentation
 */

import {
  Global,
  Module,
  type DynamicModule,
  type InjectionToken,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common'
import type { PrismaModuleAsyncOptions, PrismaModuleOptions } from './prisma.options'
import { PrismaService } from './prisma.service'
import { RawPrismaService } from './raw-prisma.service'
import { PRISMA_BASE_CLIENT, PRISMA_MODULE_OPTIONS } from './tokens'
import type { PrismaClientLike } from './types'

/**
 * 兜底的客户端工厂：运行时才去 import `@prisma/client`。
 *
 * 为什么是**运行时动态** import：本包发布时所在的仓库没有跑过 `prisma generate`，
 * `@prisma/client` 的类型入口（`.prisma/client/default`）根本不存在，
 * 顶层 `import` 会让本包自己的 `tsc --noEmit` 直接红。用一个 `string` 类型的
 * specifier 让 TS 放弃静态解析，是这种「框架包依赖生成产物」场景的标准写法。
 *
 * @throws 没跑过 `prisma generate` 时抛，报错里直接告诉你该跑什么
 */
export async function createDefaultPrismaClient(): Promise<PrismaClientLike> {
  const specifier: string = '@prisma/client'
  const loaded: unknown = await import(specifier)
  const ctor = (loaded as { PrismaClient?: unknown }).PrismaClient
  if (typeof ctor !== 'function') {
    throw new Error(
      '[@taizan/nest-prisma] 没能从 @prisma/client 拿到 PrismaClient。' +
        '请先跑 `pnpm prisma generate`，或者给 PrismaModule.forRoot({ client }) 显式传一个客户端。',
    )
  }
  return new (ctor as new () => PrismaClientLike)()
}

function coreProviders(optionsProvider: Provider): Provider[] {
  return [
    optionsProvider,
    {
      provide: PRISMA_BASE_CLIENT,
      inject: [PRISMA_MODULE_OPTIONS],
      useFactory: async (options: PrismaModuleOptions): Promise<PrismaClientLike> =>
        options.client ?? (await createDefaultPrismaClient()),
    },
    PrismaService,
    RawPrismaService,
  ]
}

/**
 * 数据访问模块。
 *
 * `@Global()`：`PrismaService` 是每个业务模块都要用的横切依赖，让它们逐个
 * `imports: [PrismaModule]` 纯属噪音（`CoreModule` 同理）。
 *
 * **不导出 `PRISMA_BASE_CLIENT`**：那是完全裸的客户端，既没有租户隔离也没有软删。
 * 它只在模块内部给 `PrismaService` 用（叠扩展、归属探针、物理删除逃生口）。
 *
 * @example
 * ```ts
 * // apps/api/src/bootstrap/app.module.ts
 * PrismaModule.forRoot({
 *   registered: TENANT_MODELS,                 // registry.freeze() 的返回值
 *   softDeleteModels: SOFT_DELETE_MODELS,
 * })
 * ```
 */
@Global()
@Module({})
export class PrismaModule {
  /** 同步装配。 */
  static forRoot(options: PrismaModuleOptions): DynamicModule {
    const providers = coreProviders({ provide: PRISMA_MODULE_OPTIONS, useValue: options })
    return {
      module: PrismaModule,
      providers,
      exports: [PrismaService, RawPrismaService],
    }
  }

  /** 选项要从别的 provider（例如 `ConfigService`）算出来时用这个。 */
  static forRootAsync(options: PrismaModuleAsyncOptions): DynamicModule {
    const providers = coreProviders({
      provide: PRISMA_MODULE_OPTIONS,
      useFactory: options.useFactory,
      inject: (options.inject ?? []) as (InjectionToken | OptionalFactoryDependency)[],
    })
    return {
      module: PrismaModule,
      imports: (options.imports ?? []) as unknown as DynamicModule['imports'],
      providers,
      exports: [PrismaService, RawPrismaService],
    }
  }
}
