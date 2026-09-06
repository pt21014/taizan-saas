/**
 * 商品的数据访问层。
 *
 * ## 全文没有一处 `tenantId`
 *
 * 这是本文件最重要的性质，也是 `test/arch/no-manual-tenant-filter.spec.ts`（spec 4）
 * 扫描的对象。每一次查询都走 `prisma.tenant`，租户条件由隔离扩展用 `AND` 包裹注入，
 * 调用方**覆盖不掉**：哪怕有人写 `where: { tenantId: '别人家' }`，最终 SQL 也是
 * `AND(tenantId = 我, tenantId = 别人家)`，结果必然是空集。
 *
 * 手写 `where.tenantId` 的问题不是「写了会错」，而是「漏写不会报错」——
 * 漏写的那一个查询会安静地返回全平台的数据。所以规则是「一次都不许写」，
 * 这样漏没漏一眼就能看出来。
 *
 * ## 跨租户访问返回什么
 *
 * 决定：**统一 `1240300`（`CROSS_TENANT_FORBIDDEN`）**，不区分「不存在」与「是别人的」。
 *
 * 依据是 `@taizan/tenant-scope` 的两条既有行为：
 * - `findUnique` 走 `checkResultOwner` 且 `throwWhenForeign: false` → 拿别人家的 id 查，
 *   结果是 `null`，和「压根没这条」长得一模一样；
 * - `update` / `delete` 走 `verifyOwnerThenExecute` → 探针发现归属不符，抛 `FOREIGN_RESULT`。
 *
 * 两条路径天然会给出两种答案（404 语义 vs 403 语义）。让 GET 和 DELETE 对同一个 id
 * 报不同的码，前端要写两套处理，而商家看到的现象是「查不到，但删的时候说没权限」。
 * 所以这里在读路径上主动收敛成同一个码：**不区分正是安全上想要的**——
 * 区分了就等于提供一个「这个 id 在不在别人家」的存在性探测器。
 *
 * 兜底（不是主路径）：`bootstrap/tenant-scope.filter.ts` 把逃出来的 `FOREIGN_RESULT`
 * 也映射成 1240300，防止某天有人忘了走 {@link GoodsService.requireOwned}。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode, normalizePage, type PageResult } from '@taizan/contracts'
import { QuotaService } from '@taizan/nest-billing'
import { BizException, currentContext } from '@taizan/nest-core'
import { QueueService } from '@taizan/nest-infra'
import { PrismaService } from '@taizan/nest-prisma'
import { mergeScopeWhere } from '@taizan/rbac-core'
import type { Goods, Prisma } from '@prisma/client'

import { autoTenantData } from '../../common/prisma.types'
import type { AppPrismaService, AppPrismaTx } from '../../common/prisma.types'
import { GOODS_SYNC_JOB_NAME, type GoodsSyncPayload } from './goods-sync.handler'
import type { CreateGoodsDto, GoodsView, ListGoodsQueryDto, UpdateGoodsDto } from './dto/goods.dto'
import {
  normalizeGoodsName,
  validateGoodsInput,
  validateGoodsPatch,
  warnOnShelfWithoutStock,
  type GoodsStatusLike,
  type RuleViolation,
} from './goods.rules'

/** 新建/修改成功时一并回给前端的「不阻塞的提示」。 */
export interface GoodsMutationResult {
  goods: GoodsView
  /** 例如「已上架但库存为 0」。没有提示时是 `null`。 */
  warning: string | null
}

function toView(row: Goods): GoodsView {
  return {
    id: row.id,
    name: row.name,
    priceCents: row.priceCents,
    stock: row.stock,
    status: row.status as GoodsStatusLike,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function rejectViolations(violations: readonly RuleViolation[]): void {
  if (violations.length === 0) return
  throw new BizException(ErrorCode.BAD_REQUEST, violations.map((v) => v.message).join('；'), {
    violations,
  })
}

/**
 * 新建商品占用哪一档配额。
 *
 * 用 `CUSTOM` 而不是新加一个 `GOODS` 枚举值：`QuotaKind` 是**框架 schema**
 * （`02-plan.prisma`）里的枚举，加一个值要动 `base.lock.json`（spec 15 看着），
 * 而它是给「业务自定义维度」预留的那一档，示例模块正是它的目标用户。
 * 真实项目如果有两种以上自定义配额，那时才值得去框架里加枚举值——
 * 在那之前共用 `CUSTOM` 的代价只是「套餐里那一项叫 CUSTOM 而不是叫商品数」。
 */
const GOODS_QUOTA_KIND = 'CUSTOM'

@Injectable()
export class GoodsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(QueueService) private readonly queue: QueueService,
  ) {}

  /**
   * 分页列表。软删的行由软删扩展自动过滤掉，这里不写 `deletedAt`。
   *
   * @param scope - `DataScopeInterceptor` 算好的数据范围片段。
   *   **`null` 与 `{}` 不是一回事**：`null` = 不加条件（`ALL` 范围），
   *   `{}` = 一个空对象条件（会被原样 AND 进去）。所以这里必须走
   *   `mergeScopeWhere` 而不是 `{ ...where, ...scope }`——后者在 `scope`
   *   是 `{ createdBy: null }` 之类的形状时会覆盖掉同名的业务条件。
   */
  async list(
    query: ListGoodsQueryDto,
    scope: Record<string, unknown> | null = null,
  ): Promise<PageResult<GoodsView>> {
    const { page, pageSize } = normalizePage(query)
    const where = mergeScopeWhere(query.status ? { status: query.status } : {}, scope)

    const [rows, total] = await Promise.all([
      this.prisma.tenant.goods.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.goods.count({ where }),
    ])

    return { items: rows.map(toView), total, page, pageSize }
  }

  /**
   * 导出：不分页，但**同样受数据范围约束**。
   *
   * 「导出」最容易漏掉数据范围——列表页加了收窄、导出忘了加，于是一个只能看自己
   * 那几条的员工点一下导出就拿到了全店数据。所以它和 `list` 用同一个 `scope` 入参，
   * 而不是另开一条查询。
   */
  async exportAll(scope: Record<string, unknown> | null = null): Promise<GoodsView[]> {
    const rows = await this.prisma.tenant.goods.findMany({
      where: mergeScopeWhere({}, scope),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    return rows.map(toView)
  }

  /** 取一条。不属于本店（或不存在）→ 1240300，理由见文件头。 */
  async get(id: string): Promise<GoodsView> {
    return toView(await this.requireOwned(id))
  }

  /** 新建。ULID 主键与 `tenantId` 都由扩展注入，这里一个都不写。 */
  async create(dto: CreateGoodsDto): Promise<GoodsMutationResult> {
    // 校验的是**生效之后**的输入，不是原始 DTO：`stock` / `status` 在 DTO 上是可选的
    // （分别默认 0 与 DRAFT），把 `undefined` 直接喂给规则函数会被判成「必填没填」。
    // 默认值只能有一处真源，就是下面这两个 `??`。
    const effective = { ...dto, stock: dto.stock ?? 0, status: dto.status ?? 'DRAFT' }
    rejectViolations(validateGoodsInput(effective))
    const name = normalizeGoodsName(dto.name)
    await this.assertNameAvailable(name)

    // ── 配额：先占，再写 ──────────────────────────────────────────────────
    // 顺序不能反。反过来（先写再占）的话，超限时业务数据已经落库了，
    // 而「回滚一条刚建好的商品」比「把多占的配额还回去」难得多。
    // 超限时 `consume` 抛 1540301（去升套餐），与到期 1440301 是两个码。
    await this.quota.consume(GOODS_QUOTA_KIND)

    let row: Goods
    try {
      row = await this.prisma.tenant.goods.create({
        // `autoTenantData` 只是类型标注：`id`（ULID）与 `tenantId` 由扩展在运行时填。
        // 在这里手写 tenantId 会直接编译不过——这是那条约定的编译期形态。
        data: autoTenantData<Prisma.GoodsCreateInput>({
          name,
          priceCents: effective.priceCents,
          stock: effective.stock,
          status: effective.status,
          // 数据范围的归属列。取自请求上下文而不是入参：让调用方传 `createdBy`
          // 等于让它可以伪造成别人建的，那样 `SELF` 范围就形同虚设。
          createdBy: currentContext()?.identity?.id ?? null,
        }),
      })
    } catch (error) {
      // 补偿：占了配额但没建成，得还回去。不还的话计数会虚高，而虚高的计数
      // 没有任何人会去修，最终表现为「明明只有 2 个商品却说超了」。
      //
      // 为什么不用一个事务把「扣配额 + 建商品」包起来（`consume(kind, 1, tx)` 是支持的）：
      // `PlatformGateway` 写 `QuotaCounter` 时带**显式 tenantId**（它是平台侧接口，
      // 跨租户是本职），而这里能拿到的 tx 是 `prisma.tenant` 的租户句柄，
      // 它会再注入一次租户条件。两种口径叠在一起是「能跑但说不清」的状态，
      // 不如用一次显式补偿——补偿失败也只是计数虚高，不会丢业务数据。
      await this.quota.release(GOODS_QUOTA_KIND).catch(() => undefined)
      throw error
    }

    // 入队一条同步任务，演示扩展点⑦。**入队在事务之外、写库成功之后**：
    // 事务里入队的话，事务回滚了消息还在，worker 会去同步一个不存在的商品。
    await this.enqueueSync(row.id, 'create')

    return {
      goods: toView(row),
      warning: warnOnShelfWithoutStock({ status: row.status as GoodsStatusLike, stock: row.stock }),
    }
  }

  /**
   * 入队 `goods.sync`。
   *
   * `tenantId` **必须显式传**——`QueueService.add` 刻意不从上下文自动取，
   * 因为「忘了传」和「这就是个平台级任务」必须区分得开。不传的后果是 worker 里
   * 没有租户上下文，处理器一用 `prisma.tenant` 就抛。
   *
   * 入队失败不让整个创建失败：商品已经建好了，因为一条同步消息没发出去就回 500，
   * 前端会重试，于是又多一个同名商品。这里只吞掉异常并留给 `QueueService` 自己的日志。
   */
  private async enqueueSync(goodsId: string, reason: string): Promise<void> {
    const tenantId = currentContext()?.tenantId
    if (tenantId === undefined) return
    const payload: GoodsSyncPayload = { goodsId, reason }
    await this.queue.add(GOODS_SYNC_JOB_NAME, payload, { tenantId }).catch(() => undefined)
  }

  /** 修改。只改传了的字段。 */
  async update(id: string, dto: UpdateGoodsDto): Promise<GoodsMutationResult> {
    rejectViolations(validateGoodsPatch(dto))
    const current = await this.requireOwned(id)

    const name = dto.name === undefined ? undefined : normalizeGoodsName(dto.name)
    if (name !== undefined && name !== current.name) {
      await this.assertNameAvailable(name)
    }

    const row = await this.prisma.tenant.goods.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.stock !== undefined ? { stock: dto.stock } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    })

    return {
      goods: toView(row),
      warning: warnOnShelfWithoutStock({ status: row.status as GoodsStatusLike, stock: row.stock }),
    }
  }

  /**
   * 删除。**软删**——`delete()` 被软删扩展改写成 `update{ deletedAt: now }`，
   * 这一层看不到差别，但库里那行还在（`@Audit` 的追溯、回收站、对账都要它）。
   */
  async remove(id: string): Promise<{ id: string }> {
    await this.requireOwned(id)
    await this.prisma.tenant.goods.delete({ where: { id } })
    // 删了就把配额还回去。软删的行不再占名额——否则「删了 10 个再建 10 个」会超限，
    // 而商家看到的商品数明明没变。
    await this.quota.release(GOODS_QUOTA_KIND)
    return { id }
  }

  /**
   * 事务里删一条。给 e2e 用例⑪用：断言软删改写出来的 `update` **确实在事务里**，
   * 事务回滚时那行不会被软删。
   *
   * 这不是给业务用的接口，但它是一条真实的执行路径——业务里「删商品的同时扣配额」
   * 就长这样。放在 service 上（而不是测试里手写）是为了让这条路径和其它写路径
   * 走同一套代码，不会「测的是一份、跑的是另一份」。
   *
   * @param id - 商品 id
   * @param after - 在同一个事务里、删除之后执行；抛错则整个事务回滚
   */
  async removeInTransaction(id: string, after: (tx: AppPrismaTx) => Promise<void>): Promise<void> {
    await this.requireOwned(id)
    await this.prisma.$transaction(async (tx) => {
      await tx.goods.delete({ where: { id } })
      await after(tx)
    })
  }

  /**
   * 拿到一条属于本店的商品，否则 1240300。
   *
   * 用 `findFirst` 而不是 `findUnique`：两者在隔离层的待遇不同——`findFirst` 的
   * 租户条件是 `AND` 包进 `where` 的（查不到就是查不到），`findUnique` 是先查后校验归属
   * （命中别人家的记录时返回 `null`，还多一次读）。既然结论都要收敛成 1240300，
   * 用前者更直接，也少一次查询。
   */
  private async requireOwned(id: string): Promise<Goods> {
    const row = await this.prisma.tenant.goods.findFirst({ where: { id } })
    if (!row) {
      throw new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN, '商品不存在，或不属于当前店铺')
    }
    return row
  }

  /**
   * 活跃商品名不能重复。
   *
   * 为什么不能只靠 `@@unique([tenantId, name, deletedAt])`：MySQL 把 `NULL` 视为
   * 互不相同，所以两行 `deletedAt IS NULL` 的同名记录**不违反**那个唯一索引
   * （`@taizan/prisma-base` README §7 记了这条已知取舍）。带上 `deletedAt` 是为了
   * 软删之后还能建回同名商品；活跃行的唯一性就只能由应用层兜。
   *
   * 已知残余风险：两个并发请求可能同时通过这个检查。真正要根治得加一列非空的
   * 软删判别列（活跃行为 `''`），那会改动 `@taizan/nest-prisma` 软删扩展的写路径契约，
   * 是跨包决策，不在 T0-8 范围内。
   */
  private async assertNameAvailable(name: string): Promise<void> {
    const existing = await this.prisma.tenant.goods.findFirst({ where: { name } })
    if (existing) {
      throw new BizException(ErrorCode.BAD_REQUEST, `已经有一个叫「${name}」的商品了`)
    }
  }
}
