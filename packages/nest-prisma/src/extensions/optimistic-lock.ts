/**
 * 乐观锁：用 `version` 列把「读-改-写」变成一次带条件的原子写。
 *
 * ## 为什么不是悲观锁 / 事务重试
 *
 * SaaS 里典型的并发写是「两个店员同时改同一个商品」，冲突率低、冲突代价小（重读再改即可）。
 * 悲观锁（`SELECT ... FOR UPDATE`）要占着行锁跨越整个业务处理时间，一旦某个请求卡在
 * 外部 HTTP 调用上，整张表就开始排队。乐观锁把代价挪到冲突发生时，不冲突时零成本。
 *
 * ## 为什么必须走 `updateMany` 而不是 `update`
 *
 * `update` 的 `where` 是唯一键形状，`version` 不在唯一键里（Prisma 5 的 extendedWhereUnique
 * 虽然允许平铺非唯一字段，但版本不匹配时 `update` 抛的是 `P2025 Not Found`，
 * 跟「记录不存在」撞在一起分不开）。`updateMany` 返回 `count`，0 就是没命中，
 * 语义干净，而且 `where` 会被租户扩展用 `AND` 包住，跨租户改不到别人的行。
 *
 * @packageDocumentation
 */

import { modelToClientKey } from '@taizan/tenant-scope'
import { OptimisticLockError } from '../errors'
import { callOperation, isPlainObject, type PrismaArgs, type PrismaClientLike } from '../types'

/** {@link updateWithVersion} 的入参。 */
export interface UpdateWithVersionParams {
  /** 定位记录的条件，通常是 `{ id }`。会与版本条件平铺合并。 */
  where: PrismaArgs
  /** 调用方读到的版本号。写入时会要求数据库里仍然是这个值。 */
  expectedVersion: number
  /** 要改的字段。`version` 由本函数负责自增，不要自己写。 */
  data: PrismaArgs
  /** 版本列名，默认 `version`。 */
  versionField?: string
}

/** {@link updateWithVersion} 的返回值。 */
export interface UpdateWithVersionResult {
  /** 写入成功后记录的新版本号（`expectedVersion + 1`）。 */
  version: number
}

/**
 * 带版本校验的更新。
 *
 * 等价 SQL：`UPDATE t SET ..., version = version + 1 WHERE <where> AND version = <expected>`，
 * 影响行数为 0 就抛 {@link OptimisticLockError}。
 *
 * @param client - Prisma 客户端。**传 `prisma.tenant`**，这样 `where` 会自动被租户条件包住。
 * @param model - Prisma 模型名（PascalCase），例如 `Goods`
 * @param params - 见 {@link UpdateWithVersionParams}
 * @returns 新版本号
 * @throws {@link OptimisticLockError} 命中 0 行（被并发改过 / 不存在 / 不属于当前租户）
 *
 * @example
 * ```ts
 * const goods = await prisma.tenant.goods.findUniqueOrThrow({ where: { id } })
 * await updateWithVersion(prisma.tenant, 'Goods', {
 *   where: { id },
 *   expectedVersion: goods.version,
 *   data: { name: '新名字' },
 * })
 * ```
 */
export async function updateWithVersion(
  client: PrismaClientLike,
  model: string,
  params: UpdateWithVersionParams,
): Promise<UpdateWithVersionResult> {
  const { where, expectedVersion, data } = params
  const versionField = params.versionField ?? 'version'

  if (!Number.isInteger(expectedVersion)) {
    throw new TypeError(
      `[@taizan/nest-prisma] ${model} 的 expectedVersion 必须是整数，收到 ${String(expectedVersion)}。`,
    )
  }

  const result = await callOperation(client, modelToClientKey(model), 'updateMany', {
    where: { ...where, [versionField]: expectedVersion },
    data: { ...data, [versionField]: { increment: 1 } },
  })

  const count = isPlainObject(result) && typeof result.count === 'number' ? result.count : 0
  if (count === 0) {
    throw new OptimisticLockError({ model, expectedVersion })
  }

  return { version: expectedVersion + 1 }
}
