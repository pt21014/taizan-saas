/**
 * 给 `seedBase()` 用的 delegate 适配层。
 *
 * ## 为什么需要它（这是一个真实踩到的坑）
 *
 * `@taizan/prisma-base` 的 seed 对 `Role` / `Staff` 用的是带 `deletedAt: null` 的**复合唯一键**
 * upsert（`tenantId_code_deletedAt` / `tenantId_accountId_deletedAt`）——那是蓝图 §3.1
 * 「软删表的唯一索引必须带 deletedAt」的直接后果。
 *
 * 但 **Prisma 6.19 的客户端拒绝在唯一键里传 `null`**：
 *
 * ```
 * Argument `deletedAt` must not be null.
 * ```
 *
 * 它的理由不算离谱：SQL 里 `NULL` 不等于任何值（包括 `NULL`），所以「按 `deletedAt IS NULL`
 * 定位唯一一行」这件事数据库层面本来就不成立——那个唯一索引在活跃行之间根本不生效
 * （`@taizan/prisma-base` README §7 把这条已知取舍写清楚了）。
 *
 * README 同一节也给出了应对：「改用 `findFirst` + `create` 自行封装」。本文件就是那份封装。
 *
 * ## 为什么封装在 apps/api 而不是改框架包
 *
 * `SeedContext` 是**鸭子类型**（`{ upsert(args) }`），框架刻意没有 import `PrismaClient`。
 * 也就是说这个扩展点是设计好的：下游遇到自己 Prisma 版本的行为差异时，
 * 塞一个自己的 delegate 进去即可，不需要动框架。改框架反而会把「哪个 Prisma 版本
 * 接受 null 唯一键」这件事固化进包里。
 *
 * @packageDocumentation
 */

import type { SeedDelegate, SeedRow, SeedUpsertArgs } from '@taizan/prisma-base'

/** 一个「长得像 Prisma 模型 delegate」的最小形状。 */
interface MinimalDelegate {
  findFirst(args: {
    where: Record<string, unknown>
    select: { id: true }
  }): Promise<{ id: string } | null>
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<{ id: string }>
}

/**
 * 把复合唯一键里的 `{ 复合键名: { a, b, deletedAt: null } }` 摊平成
 * 普通的 `where`（`{ a, b, deletedAt: null }`）。
 *
 * `findFirst` 的 `where` 是 `XxxWhereInput`，它**接受** `deletedAt: null`
 * （那就是普通的 `IS NULL` 过滤条件，不是唯一键定位），所以摊平之后就能查了。
 *
 * @param where - `upsert` 的原始 where
 * @returns 可以直接喂给 `findFirst` 的 where
 */
export function flattenCompoundWhere(where: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(where)
  // 只有一个键、且它的值是对象 → 判定为复合唯一键包装，摊开它。
  const single = entries.length === 1 ? entries[0] : undefined
  if (single && typeof single[1] === 'object' && single[1] !== null && !Array.isArray(single[1])) {
    return { ...(single[1] as Record<string, unknown>) }
  }
  return { ...where }
}

/**
 * 用 `findFirst` + `create` / `update` 实现的 upsert。
 *
 * 与真 `upsert` 的差别：**不是原子的**。两个并发的 seed 进程可能都查到「没有」然后都去
 * create，其中一个会撞唯一索引失败。seed 是本地/初始化时单进程跑一次的东西，
 * 这个代价可以接受；业务代码里**不要**照抄这个形状。
 *
 * @param delegate - Prisma 模型 delegate
 */
export function findFirstUpsertDelegate(delegate: MinimalDelegate): SeedDelegate {
  return {
    async upsert(args: SeedUpsertArgs): Promise<SeedRow> {
      const where = flattenCompoundWhere(args.where)
      const existing = await delegate.findFirst({ where, select: { id: true } })
      if (existing) {
        return delegate.update({ where: { id: existing.id }, data: args.update })
      }
      return delegate.create({ data: args.create })
    },
  }
}
