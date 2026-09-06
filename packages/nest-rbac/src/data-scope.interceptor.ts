/**
 * `DataScopeInterceptor`：把 `@DataScope()` 声明翻译成一段 Prisma `where` 片段。
 *
 * 守卫链里它排在三个守卫之后（蓝图 §4.3）：数据范围是「你能看见哪些行」，
 * 前提是你已经被允许调这个接口。
 *
 * @packageDocumentation
 */

import {
  Inject,
  Injectable,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { AuthPrincipal, RequestWithPrincipal } from '@taizan/nest-auth'
import { AppLogger, BizException } from '@taizan/nest-core'
import { buildScopeWhere, type DataScope as DataScopeValue } from '@taizan/rbac-core'
import type { Observable } from 'rxjs'
import { DATA_SCOPE_KEY, SCOPE_WHERE_PROPERTY, type DataScopeOptions } from './decorators'
import { RBAC_ERRORS } from './errors'
import { SUBTREE_RESOLVER } from './tokens'

/**
 * `SUB_TREE` 范围下「本人所在组织及其全部下级」的解析器。
 *
 * 组织树不在框架里——`04-rbac.prisma` 只有 `Staff.dataScope`，没有部门表。
 * 需要 `SUB_TREE` 的业务项目自己建组织表并实现这个接口，装配时
 * `RbacModule.forRoot({ subtreeResolver })` 传进来。
 */
export interface SubtreeResolver {
  /**
   * @param principal - 当前主体（`principal.id` 是 `Staff.id`）
   * @returns 可见的组织 id 列表。**返回空数组表示一个都看不到**（永假条件），
   *   不是「看全部」——这条语义由 `@taizan/rbac-core` 的 `buildScopeWhere` 保证。
   */
  resolve(principal: AuthPrincipal): Promise<string[]> | string[]
}

/**
 * 默认实现：把自己当成一棵只有自己的树。
 *
 * 之所以不抛错：`SUB_TREE` 是四档里唯一需要外部数据的，没配解析器时最合理的行为是
 * **退化成 SELF**（少给），而不是 500，更不是「没有 subtreeIds 就不加条件」（那会翻转成看全部）。
 * 没配解析器却给员工设了 `SUB_TREE`，表现就是「他只看得到自己的」，这会被业务方发现并上报，
 * 而反过来的错误（看到全店数据）不会有人来报。
 */
export class SelfOnlySubtreeResolver implements SubtreeResolver {
  resolve(principal: AuthPrincipal): string[] {
    return [principal.id]
  }
}

/**
 * `AuthPrincipal` 的数据范围扩展。
 *
 * `CUSTOM` 需要 `Staff.scopeTargets`，而 `@taizan/nest-auth` 的 `AuthPrincipal`
 * 目前只带 `roleIds` / `dataScope` / `isOwner` 三个字段。
 * **TODO（待补）**：在 `@taizan/nest-auth` 的 `Membership` / `AuthPrincipal` 上补
 * `scopeTargets`（同样只来自库），之后删掉这个交叉类型。在那之前，本拦截器按
 * 「读得到就用、读不到当空」处理——空 `scopeTargets` 在 `buildScopeWhere` 里是永假条件，
 * 方向仍然是少给。
 */
export interface ScopedPrincipal extends AuthPrincipal {
  /** `CUSTOM` 范围下被显式授权的对象 id；`null` / `[]` 都表示一个都不给。 */
  scopeTargets?: string[] | null
}

/** `Reflector.getAllAndOverride` 的第二个参数类型（handler + class）。 */
type ReflectorTargets = Parameters<Reflector['getAllAndOverride']>[1]

@Injectable()
export class DataScopeInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SUBTREE_RESOLVER) private readonly subtree: SubtreeResolver,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle()

    const targets: ReflectorTargets = [context.getHandler(), context.getClass()]
    const options = this.reflector.getAllAndOverride<DataScopeOptions>(DATA_SCOPE_KEY, targets)
    if (options === undefined) return next.handle()

    const req = context.switchToHttp().getRequest<RequestWithPrincipal>()
    const principal = req.principal as ScopedPrincipal | undefined

    // 非 staff（platform / member / 未认证）不做数据范围收窄：
    // 数据范围是**租户内**的再收窄，只对员工有意义。平台超管跨租户看数据是它的职责，
    // 该不该看由 PermissionsGuard 与租户隔离决定，不由这里。
    const scope: DataScopeValue | undefined =
      principal?.kind === 'staff' ? (principal.dataScope ?? 'SELF') : undefined

    const where =
      scope === undefined
        ? null
        : this.build(
            scope,
            principal as ScopedPrincipal,
            options,
            await this.subtreeIds(scope, principal as ScopedPrincipal),
          )

    ;(req as unknown as Record<string, unknown>)[SCOPE_WHERE_PROPERTY] = where
    return next.handle()
  }

  private async subtreeIds(scope: DataScopeValue, principal: ScopedPrincipal): Promise<string[]> {
    if (scope !== 'SUB_TREE') return []
    return this.subtree.resolve(principal)
  }

  private build(
    scope: DataScopeValue,
    principal: ScopedPrincipal,
    options: DataScopeOptions,
    subtreeIds: string[],
  ): Record<string, unknown> | null {
    try {
      return buildScopeWhere(
        scope,
        {
          subjectId: principal.id,
          scopeTargets: principal.scopeTargets ?? null,
          subtreeIds,
        },
        options,
      )
    } catch (error) {
      // buildScopeWhere 只在**配置错误**时抛（SUB_TREE 少了 groupField、未知 scope）。
      // 失败关闭成 403 而不是 500：500 会被前端当「系统坏了」重试，
      // 而这是一条改代码才能修的错，重试没有意义。
      this.logger?.error(
        `[@taizan/nest-rbac] @DataScope() 配置错误：${(error as Error).message}`,
        'DataScopeInterceptor',
      )
      throw new BizException(RBAC_ERRORS.DATA_SCOPE_MISCONFIGURED)
    }
  }
}
