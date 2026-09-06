/**
 * `PrismaModule.forRoot()` / `forRootAsync()` 的选项类型。
 *
 * 单独成文件是为了让 `prisma.service.ts` 与 `prisma.module.ts` 都能 import 它而不成环。
 *
 * @packageDocumentation
 */

import type { NestedCreateStrategy, TenantModelLookup } from '@taizan/tenant-scope'
import type { PrismaClientLike } from './types'

/** 装配选项。 */
export interface PrismaModuleOptions {
  /**
   * 受租户隔离约束的模型集合。传 `createTenantModelRegistry(...).freeze()` 的返回值，
   * 或直接一个 `ReadonlySet<string>`。
   *
   * **漏登记 = 静默泄漏**，所以项目侧必须配 `verifySchema` 的双向比对 spec。
   */
  registered: TenantModelLookup

  /** 有 `deletedAt` 列的模型集合（PascalCase）。不在集合里的模型软删扩展完全不碰。 */
  softDeleteModels: ReadonlySet<string>

  /**
   * 已经建好的 Prisma 客户端。不传就在启动时 `import('@prisma/client')` 自己 new 一个。
   *
   * 测试里传替身（`createFakePrisma().client`）就能整条链不连库跑起来。
   */
  client?: PrismaClientLike

  /**
   * 取当前租户 id，默认读 `@taizan/nest-core` 的请求上下文。
   *
   * **取不到必须返回 `undefined`**，不要兜底成某个默认租户——那等于给所有无上下文的
   * 请求开了一扇跨租户的门。
   */
  getTenantId?: () => string | undefined

  /** 关系字段名到目标模型名的映射，用于一层嵌套 `create` 的注入判断。 */
  nestedModels?: Readonly<Record<string, string>>

  /** 嵌套 `create` 的注入策略，默认 `'mapped'`。 */
  nestedCreate?: NestedCreateStrategy

  /** 遇到未登记模型的行为，默认 `'passthrough'`。测试环境建议 `'throw'`。 */
  onUnregistered?: 'passthrough' | 'throw'

  /** 软删列名，默认 `deletedAt`。 */
  softDeleteField?: string

  /** 取「现在」，默认 `() => new Date()`。 */
  now?: () => Date

  /** 判断模型的 `id` 是不是 `String`，默认全部为真（蓝图 §3.1 规定主键一律 ULID）。 */
  hasStringId?: (model: string) => boolean

  /** 主键字段名，默认 `id`。 */
  idField?: string

  /** 主键生成器，默认 `@taizan/contracts` 的 `ulid`。 */
  generateId?: () => string

  /** `db` 健康探针的超时（毫秒），默认 2000。 */
  healthCheckTimeoutMs?: number

  /** `onModuleInit` 时是否 `$connect()`，默认 `true`。测试传替身时可以关掉。 */
  connectOnInit?: boolean
}

/** `forRootAsync` 的选项。 */
export interface PrismaModuleAsyncOptions {
  /** 工厂依赖的 provider token。 */
  inject?: unknown[]
  /** 造选项的工厂，可以是异步的。 */
  useFactory: (...args: never[]) => PrismaModuleOptions | Promise<PrismaModuleOptions>
  /** 需要额外 import 的模块（例如提供 `ConfigService` 的那个）。 */
  imports?: unknown[]
}
