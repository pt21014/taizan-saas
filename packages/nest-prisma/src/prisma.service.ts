/**
 * `PrismaService`：两个句柄（`tenant` / `raw`）+ 一个 `db` 健康探针。
 *
 * @packageDocumentation
 */

import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { currentContext, HealthRegistry, type HealthIndicator } from '@taizan/nest-core'
import { createSoftDeleteExtension, hardDelete, hardDeleteMany } from './extensions/soft-delete'
import { createTenantExtension } from './extensions/tenant'
import { createUlidExtension } from './extensions/ulid'
import {
  updateWithVersion,
  type UpdateWithVersionParams,
  type UpdateWithVersionResult,
} from './extensions/optimistic-lock'
import { PRISMA_BASE_CLIENT, PRISMA_MODULE_OPTIONS } from './tokens'
import type { ModelDelegate, PrismaArgs, PrismaClientLike } from './types'
import type { PrismaModuleOptions } from './prisma.options'

/**
 * 叠加扩展之后的客户端。
 *
 * 框架层拿不到 `prisma generate` 的产物，所以这里只能是结构化类型；业务项目在
 * `apps/api` 里用自己的生成类型收窄（`PrismaService<typeof myExtendedClient>`）。
 */
export type ExtendedPrismaClient = Record<string, ModelDelegate>

/** 带超时的 `SELECT 1` 探针。 */
export class DbHealthIndicator implements HealthIndicator {
  readonly name = 'db'

  constructor(
    private readonly base: PrismaClientLike,
    private readonly timeoutMs: number,
  ) {}

  /**
   * 探测数据库。
   *
   * **自带超时**：探针挂死会把 `/health` 一起拖死，而 `/health` 挂死时反向代理拿不到
   * 503，反而不会把这台实例摘出去——比直接返回 `down` 糟得多。
   */
  async check(): Promise<'up' | 'down'> {
    let timer: NodeJS.Timeout | undefined
    try {
      const query = (
        this.base as {
          $queryRaw?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
        }
      ).$queryRaw
      if (typeof query !== 'function') return 'down'

      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`[@taizan/nest-prisma] db 探针超时（${this.timeoutMs}ms）`)),
          this.timeoutMs,
        )
      })
      // 用标签模板调用，`$queryRaw` 才拿得到带 `.raw` 的 TemplateStringsArray。
      const queryRaw = query.bind(this.base)
      await Promise.race([queryRaw`SELECT 1`, timeout])
      return 'up'
    } catch {
      // 探针不往外抛：`/health` 要的是一个 up/down，不是 500。
      return 'down'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * 数据访问入口。**业务代码只准用 `tenant`。**
 *
 * ## 两个句柄
 *
 * | 句柄 | 叠了什么 | 谁能用 |
 * |---|---|---|
 * | `tenant` | tenant → softDelete → ulid | 所有业务代码 |
 * | `raw` | softDelete → ulid（**没有租户注入**） | 只有三处，见下 |
 *
 * ## `raw` 的三处合法用途（其余一律视为事故）
 *
 * 1. **登录跨租户找账号**：用户输入手机号时还不知道他属于哪个租户，必须全表找。
 * 2. **支付回调按参数定位租户**：回调来自外部，没有登录态，只能靠 `outTradeNo` 反查。
 * 3. **平台后台**：平台管理员本来就要跨租户看数据。
 *
 * 每个用点必须写 `// raw-reason: <理由>` 注释，由 spec 3（`raw-usage.spec.ts`，T0-8）
 * 扫描源码白名单看住。想让「谁在用 raw」更好扫，注入 {@link RawPrismaService} 而不是
 * `prisma.raw`。
 *
 * ## 叠加顺序
 *
 * `base.$extends(tenant).$extends(softDelete).$extends(ulid)`——**先 `$extends` 的先执行**
 * （最外层）。租户必须最外层，理由见 `extensions/soft-delete.ts` 的文件头。
 *
 * @typeParam TClient - 叠加后的客户端类型。业务项目传自己 `prisma generate` 出来的类型。
 */
@Injectable()
export class PrismaService<TClient = ExtendedPrismaClient>
  implements OnModuleInit, OnModuleDestroy
{
  /** 租户强隔离句柄。没有租户上下文时对租户域模型的任何操作直接抛 `TenantScopeError`。 */
  readonly tenant: TClient

  /** 无租户注入的句柄。**只允许上面列的三处用**。 */
  readonly raw: TClient

  /** `db` 健康探针。`PrismaModule` 会在 `onModuleInit` 时注册进 `HealthRegistry`。 */
  readonly healthIndicator: DbHealthIndicator

  private readonly base: PrismaClientLike
  private readonly connectOnInit: boolean

  constructor(
    @Inject(PRISMA_BASE_CLIENT) base: PrismaClientLike,
    @Inject(PRISMA_MODULE_OPTIONS) options: PrismaModuleOptions,
    @Optional() @Inject(HealthRegistry) private readonly health?: HealthRegistry,
  ) {
    this.base = base
    this.connectOnInit = options.connectOnInit ?? true

    const softDelete = createSoftDeleteExtension(options.softDeleteModels, {
      field: options.softDeleteField,
      now: options.now,
    })
    const ulid = createUlidExtension({
      hasStringId: options.hasStringId,
      field: options.idField,
      generate: options.generateId,
    })

    const extend = (client: PrismaClientLike, extension: unknown): PrismaClientLike =>
      (client as { $extends(ext: unknown): PrismaClientLike }).$extends(extension)

    // 租户扩展的归属探针必须拿**未叠加任何扩展**的 base：探针要看到已软删的记录，
    // 否则更新一条软删记录时探针查不到，归属校验会被静默跳过。
    const tenantExtension = createTenantExtension({
      getTenantId: options.getTenantId ?? ((): string | undefined => currentContext()?.tenantId),
      registered: options.registered,
      raw: base,
      nestedModels: options.nestedModels,
      nestedCreate: options.nestedCreate,
      onUnregistered: options.onUnregistered,
    })

    this.tenant = extend(extend(extend(base, tenantExtension), softDelete), ulid) as TClient
    this.raw = extend(extend(base, softDelete), ulid) as TClient
    this.healthIndicator = new DbHealthIndicator(base, options.healthCheckTimeoutMs ?? 2000)
  }

  async onModuleInit(): Promise<void> {
    if (this.connectOnInit) {
      const connect = (this.base as { $connect?: () => Promise<void> }).$connect
      if (typeof connect === 'function') await connect.call(this.base)
    }
    this.health?.register(this.healthIndicator)
  }

  async onModuleDestroy(): Promise<void> {
    const disconnect = (this.base as { $disconnect?: () => Promise<void> }).$disconnect
    if (typeof disconnect === 'function') await disconnect.call(this.base)
  }

  /**
   * 事务。**透传给 `tenant` 句柄的 `$transaction`**，所以事务内的每一次调用仍然会走
   * 全部三个扩展（Prisma 的交互式事务客户端保留扩展）。
   *
   * 注意：`AsyncLocalStorage` 的租户上下文在回调里照常可见——回调是在同一条异步链上跑的。
   *
   * @param fn - 事务体，参数是带扩展的事务客户端
   */
  async $transaction<T>(fn: (tx: TClient) => Promise<T>): Promise<T> {
    const runner = (this.tenant as { $transaction?: unknown }).$transaction
    if (typeof runner !== 'function') {
      throw new TypeError('[@taizan/nest-prisma] 当前客户端不支持 $transaction。')
    }
    return (runner as (cb: (tx: TClient) => Promise<T>) => Promise<T>).call(this.tenant, fn)
  }

  /**
   * 乐观锁更新，走 `tenant` 句柄（所以 `where` 会被租户条件包住）。
   *
   * @throws `OptimisticLockError` 命中 0 行
   */
  async updateWithVersion(
    model: string,
    params: UpdateWithVersionParams,
  ): Promise<UpdateWithVersionResult> {
    return updateWithVersion(this.tenant as PrismaClientLike, model, params)
  }

  /**
   * 物理删除逃生口。走**未叠加任何扩展**的 base 客户端：既不软删改写，也不注入租户。
   *
   * 合法用途只有合规要求的「彻底删除个人数据」与测试夹具清理。调用点必须写
   * `// raw-reason: <理由>`。
   */
  async hardDelete(model: string, args: PrismaArgs): Promise<unknown> {
    return hardDelete(this.base, model, args)
  }

  /** 物理批量删除逃生口。约束同 {@link PrismaService.hardDelete}。 */
  async hardDeleteMany(model: string, args: PrismaArgs): Promise<unknown> {
    return hardDeleteMany(this.base, model, args)
  }
}
