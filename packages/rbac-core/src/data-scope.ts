/**
 * 数据范围（蓝图 §3.2 `DataScope` 枚举、§4.4 结尾）：把 `Staff.dataScope` +
 * `Staff.scopeTargets` 翻译成一段 Prisma `where` 片段，由 `@taizan/nest-rbac`
 * 的 `@DataScope()` 拦截器自动 AND 进业务查询。
 *
 * **这一层的第一原则是「空集合意味着查不到，而不是查全部」**。
 * `CUSTOM` 授权了 0 个对象、`SUB_TREE` 算出 0 个下级组织，正确结果都是一条数据都看不到；
 * 如果实现成「没有条件就不加条件」，就会从「什么都看不到」翻转成「什么都看得到」——
 * 这是数据范围功能最经典也最致命的一个 bug，所以这里显式返回 `{ in: [] }` 这种**永假条件**。
 *
 * 注意：数据范围是**租户内**的再收窄，租户隔离由 `@taizan/tenant-scope` 独立负责，
 * 两者互不替代，`ALL` 只表示「本租户内全部数据」。
 */

/** 数据范围枚举（与 `04-rbac.prisma` 的 `DataScope` 一一对应）。 */
export type DataScope = 'ALL' | 'SUB_TREE' | 'SELF' | 'CUSTOM'

/** 全部合法的数据范围取值，供 DTO 校验与穷举测试使用。 */
export const DATA_SCOPES = ['ALL', 'SUB_TREE', 'SELF', 'CUSTOM'] as const

/** {@link buildScopeWhere} 的主体上下文（当前登录员工在数据范围上的画像）。 */
export interface ScopeSubject {
  /** 当前主体 ID（一般是 `Staff.id`），`SELF` 与 `CUSTOM` 的兜底比较对象 */
  subjectId: string
  /** `CUSTOM` 范围下被显式授权的对象 ID 列表；`null` / `[]` 都表示一个都不给 */
  scopeTargets?: string[] | null
  /** `SUB_TREE` 范围下由调用方算好的「本人所在组织及其全部下级」ID 列表；空表示一个都不给 */
  subtreeIds?: string[]
}

/** {@link buildScopeWhere} 的字段映射（业务表用哪一列表示归属）。 */
export interface ScopeFields {
  /** 归属人字段，如 `'createdBy'` / `'staffId'`；`SELF` 与 `CUSTOM` 用它 */
  ownerField: string
  /** 组织字段，如 `'deptId'` / `'shopId'`；`SUB_TREE` 用它，用 `SUB_TREE` 时必填 */
  groupField?: string
}

function neverMatch(field: string): Record<string, unknown> {
  // Prisma 语义：`{ in: [] }` 永远匹配不到任何行。刻意不用 `{ id: null }` 之类的技巧，
  // 因为那依赖具体列可空性；`in: []` 对任何列都成立且在 SQL 层被优化成 false。
  return { [field]: { in: [] as string[] } }
}

/**
 * 构造数据范围对应的 Prisma `where` 片段。
 *
 * | scope | 返回 |
 * |---|---|
 * | `ALL` | `null`（不加任何条件；租户隔离仍由 `@taizan/tenant-scope` 负责） |
 * | `SELF` | `{ [ownerField]: subjectId }` |
 * | `SUB_TREE` | `{ [groupField]: { in: subtreeIds } }`；`subtreeIds` 为空 → **永假条件** `{ in: [] }` |
 * | `CUSTOM` | `{ [ownerField]: { in: scopeTargets } }`；`scopeTargets` 为 `null` / `[]` → **永假条件** |
 *
 * @param scope - 数据范围
 * @param ctx - 主体上下文
 * @param fields - 业务表的字段映射
 * @returns `where` 片段；`ALL` 返回 `null` 表示「不需要额外条件」
 * @throws `SELF` 缺 `subjectId`、`SUB_TREE` 缺 `groupField`、或传入未知 scope 时抛出。
 *   这三种都是调用方配置错误，抛错（失败关闭）比返回一个可能放行全表的条件安全。
 *
 * @example
 * ```ts
 * buildScopeWhere('CUSTOM', { subjectId: 's1', scopeTargets: [] }, { ownerField: 'createdBy' })
 * // => { createdBy: { in: [] } }  ← 查不到任何数据，不是查全部
 * ```
 */
export function buildScopeWhere(
  scope: DataScope,
  ctx: ScopeSubject,
  fields: ScopeFields,
): Record<string, unknown> | null {
  switch (scope) {
    case 'ALL':
      return null

    case 'SELF': {
      if (typeof ctx.subjectId !== 'string' || ctx.subjectId.length === 0) {
        throw new Error('[@taizan/rbac-core] SELF 数据范围缺少 subjectId')
      }
      return { [fields.ownerField]: ctx.subjectId }
    }

    case 'SUB_TREE': {
      const groupField = fields.groupField
      if (groupField === undefined || groupField.length === 0) {
        throw new Error('[@taizan/rbac-core] SUB_TREE 数据范围需要在 fields 里指定 groupField')
      }
      const ids = ctx.subtreeIds ?? []
      if (ids.length === 0) {
        return neverMatch(groupField)
      }
      return { [groupField]: { in: [...ids] } }
    }

    case 'CUSTOM': {
      const targets = ctx.scopeTargets ?? []
      if (targets.length === 0) {
        return neverMatch(fields.ownerField)
      }
      return { [fields.ownerField]: { in: [...targets] } }
    }

    default: {
      // 未知取值一律失败关闭：新增枚举值忘了在这里处理时，宁可 500 也不要静默放行全表。
      const unknown: string = scope
      throw new Error(`[@taizan/rbac-core] 未知的数据范围 "${unknown}"`)
    }
  }
}

/**
 * 把数据范围条件 AND 进业务自己的 `where`。
 *
 * 用 `{ AND: [base, scope] }` 包裹而不是浅合并键，这样业务侧即便在 `base` 里写了同名字段
 * 也无法覆盖掉数据范围条件（与 `@taizan/tenant-scope` 里租户条件的处理方式保持一致）。
 *
 * @param base - 业务自己的 `where`，可为 `undefined` / `null`
 * @param scope - {@link buildScopeWhere} 的返回值；`null` 表示无需收窄，原样返回 `base`
 */
export function mergeScopeWhere(
  base: Record<string, unknown> | null | undefined,
  scope: Record<string, unknown> | null,
): Record<string, unknown> {
  const hasBase = base !== null && base !== undefined && Object.keys(base).length > 0
  if (scope === null) {
    return hasBase ? { ...base } : {}
  }
  if (!hasBase) {
    return { ...scope }
  }
  return { AND: [{ ...base }, { ...scope }] }
}
