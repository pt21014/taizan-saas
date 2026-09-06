/**
 * `PermissionsGuard`：守卫链的第二环（蓝图 §4.3）。
 *
 * ```
 * GlobalAuthGuard → PermissionsGuard → BillingGateGuard → (拦截器) DataScopeInterceptor → AuditInterceptor
 * ```
 *
 * 顺序在 `apps/api/src/bootstrap/app.module.ts` 的 `APP_GUARD` 数组里一处定死。
 * 本守卫**假定 `GlobalAuthGuard` 已经跑过**：认证（你是谁）不归它管，
 * 它只回答「这个已经认出来的人，配不配调这条接口」。
 *
 * @packageDocumentation
 */

import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { RequestWithPrincipal } from '@taizan/nest-auth'
import { AppLogger, BizException } from '@taizan/nest-core'
import { collectExprCodes, evaluatePermission, type PermissionExpr } from '@taizan/rbac-core'
import { REQUIRE_PERMISSION_KEY } from './decorators'
import { RBAC_ERRORS } from './errors'
import { PermissionRegistry } from './registry'
import { RolePermissionsService } from './role-permissions.service'
import { PERMISSION_REGISTRY } from './tokens'

/** `req` 上缓存已展开权限点集合的属性名（同一请求里 bootstrap / 审计可以复用，不再算一遍）。 */
export const GRANTED_PERMISSIONS_PROPERTY = 'grantedPermissions'

/** `Reflector.getAllAndOverride` 的第二个参数类型（handler + class）。 */
type ReflectorTargets = Parameters<Reflector['getAllAndOverride']>[1]

@Injectable()
export class PermissionsGuard implements CanActivate {
  /** process-local: 已经就某个未注册 code 报过错的集合，避免每请求刷屏。 */
  private readonly warnedCodes = new Set<string>()

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RolePermissionsService) private readonly rolePermissions: RolePermissionsService,
    @Inject(PERMISSION_REGISTRY) private readonly permissions: PermissionRegistry,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 只管 HTTP，理由同 GlobalAuthGuard：队列消费者没有「路由权限」这个概念。
    if (context.getType() !== 'http') return true

    const targets: ReflectorTargets = [context.getHandler(), context.getClass()]
    const expr = this.reflector.getAllAndOverride<PermissionExpr>(REQUIRE_PERMISSION_KEY, targets)

    // ── 没有 metadata → 放行 ────────────────────────────────────────────
    // 这里的「放行」不等于「公开」：默认拒绝已经由 GlobalAuthGuard 在上一环兑现了
    // （没 token 根本走不到这里）。本守卫的职责只有「有声明就判定」，
    // 把它也做成默认拒绝的话，每一条不需要细粒度权限的接口（改自己的密码、
    // 拉自己的待办）都要写一个假权限点，那种噪音最后会让所有人复制粘贴同一个万能 code。
    if (expr === undefined) return true

    const req = context.switchToHttp().getRequest<RequestWithPrincipal>()
    const principal = req.principal
    if (principal === undefined) {
      // 走到这里说明这条路由既标了 @RequirePermission 又标了 @Public()（或者守卫链被改乱了）。
      // 失败关闭：这是装配错误，不能用「没有主体所以不判定」把它放过去。
      throw new BizException(RBAC_ERRORS.FORBIDDEN)
    }

    // ── platform：放行 ──────────────────────────────────────────────────
    // 平台超管（`/api/platform`）在本框架里是**全权**身份：它能开通/冻结租户、
    // 改套餐、看跨租户看板，任何一条商家侧权限点对它都没有约束意义。
    // TODO（平台侧细粒度）：等平台后台的角色体系（`RolePreset.side = 'PLATFORM'`）
    // 落地后，这里改为「按平台管理员自己的角色判定」，并把商家侧权限点与平台侧权限点
    // 分成两个命名空间（现在共用一张 Permission 表，只靠 Menu.side 区分）。
    // 在那之前，平台侧的约束靠「谁能拿到 platform token」+ `@Audit()` 全量审计兜。
    if (principal.kind === 'platform') return true

    // ── member：有 metadata 即拒 ────────────────────────────────────────
    // C 端会员不参与后台 RBAC。它能走到这里说明这条 admin 接口没写 `@Auth('staff')`，
    // 那是个装配疏漏；这里拒绝掉，而不是去猜它想干什么。
    if (principal.kind !== 'staff') {
      throw new BizException(RBAC_ERRORS.FORBIDDEN)
    }

    this.warnUnregistered(expr)

    const granted = await this.rolePermissions.grantedFor(principal)
    // 同一请求里 bootstrap / 审计可以直接拿，不再查一次角色。
    ;(req as unknown as Record<string, unknown>)[GRANTED_PERMISSIONS_PROPERTY] = granted

    if (!evaluatePermission(expr, granted)) {
      throw new BizException(RBAC_ERRORS.FORBIDDEN)
    }
    return true
  }

  /**
   * 表达式引用了注册表里没有的 code 时打一条 error。
   *
   * 不抛错：未注册的 code 永远不在 `granted` 里，结果本来就是拒绝（安全的一侧），
   * 把它升级成 500 只会把一个「上线前该被 spec 6 拦住的拼写错误」变成线上事故。
   * CI 上的硬拦截在 `arch/require-permission.scan.ts`（蓝图 §8 spec 6）。
   */
  private warnUnregistered(expr: PermissionExpr): void {
    for (const code of collectExprCodes(expr)) {
      if (this.permissions.has(code) || this.warnedCodes.has(code)) continue
      this.warnedCodes.add(code)
      this.logger?.error(
        `[@taizan/nest-rbac] @RequirePermission("${code}") 引用了未注册的权限点：` +
          `该路由将永远返回 ${RBAC_ERRORS.FORBIDDEN.code}。请在 definePermissions() 里补上，` +
          `或修正拼写（CI 上由 permission-registry.spec.ts 硬拦截）`,
        'PermissionsGuard',
      )
    }
  }
}
