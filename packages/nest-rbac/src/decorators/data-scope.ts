/**
 * `@DataScope()`：声明一条路由的数据范围收窄字段，以及取结果的 `@ScopeWhere()`。
 *
 * @packageDocumentation
 */

import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common'
import type { ScopeFields } from '@taizan/rbac-core'

/** `@DataScope()` 的 metadata key。 */
export const DATA_SCOPE_KEY = 'taizan:rbac:data-scope'

/** `req` 上存放数据范围 `where` 片段的属性名。 */
export const SCOPE_WHERE_PROPERTY = 'scopeWhere'

/**
 * `@DataScope()` 的入参：这张业务表用哪一列表示归属。
 *
 * 与 `@taizan/rbac-core` 的 `ScopeFields` 同一个形状（本包不重新发明字段名），
 * 蓝图 §4.4 示例里的 `tenantField` **刻意不在这里**：租户隔离由
 * `@taizan/tenant-scope` + `prisma.tenant` 句柄独立负责，在数据范围里再写一遍
 * 等于给「禁止手写 tenantId 过滤条件」开了个口子（蓝图 §8 spec 4 会扫出来）。
 */
export type DataScopeOptions = ScopeFields

/**
 * 声明这条路由（或整个控制器）要按当前员工的数据范围收窄。
 *
 * `DataScopeInterceptor` 读到它之后，按 `principal.dataScope` 调
 * `@taizan/rbac-core` 的 `buildScopeWhere()`，把结果挂到 `req.scopeWhere`，
 * service 用 {@link ScopeWhere} 取出来再 `mergeScopeWhere()` 进自己的查询条件。
 *
 * ## 为什么不自动改写查询
 *
 * 租户隔离能自动改写（`prisma.tenant` 句柄，模型级、无歧义）；数据范围不能——
 * 「归属人」在不同表里是不同的列（`createdBy` / `staffId` / `ownerId`），
 * 而且同一个请求里可能查好几张表，只有业务代码知道该收窄哪一次查询。
 * 自动改写在这里只会变成「有时候生效有时候不生效」，那比不生效更危险。
 *
 * @example
 * ```ts
 * @Get('list')
 * @RequirePermission('order:list')
 * @DataScope({ ownerField: 'createdBy', groupField: 'deptId' })
 * list(@ScopeWhere() scope: Record<string, unknown> | null) {
 *   return this.orders.list(mergeScopeWhere({ status: 'PAID' }, scope))
 * }
 * ```
 */
export const DataScope = (options: DataScopeOptions): MethodDecorator & ClassDecorator => {
  if (typeof options.ownerField !== 'string' || options.ownerField.length === 0) {
    throw new Error('[@taizan/nest-rbac] @DataScope() 必须指定 ownerField')
  }
  return SetMetadata(DATA_SCOPE_KEY, options)
}

/**
 * 取出 `DataScopeInterceptor` 算好的数据范围 `where` 片段。
 *
 * 返回 `null` 表示「不需要额外条件」（`dataScope: 'ALL'`，或这条路由没标 `@DataScope()`）。
 * **`null` 与 `{}` 在这里必须区分**：`{}` 是「空对象条件」，`mergeScopeWhere` 会
 * 原样 AND 进去；`null` 才是「不加条件」。这也是为什么不给它一个 `{}` 默认值。
 */
export const ScopeWhere = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Record<string, unknown> | null => {
    if (ctx.getType() !== 'http') return null
    const req = ctx.switchToHttp().getRequest<Record<string, unknown>>()
    const value = req[SCOPE_WHERE_PROPERTY]
    return (value as Record<string, unknown> | null | undefined) ?? null
  },
)
