/**
 * `AuditInterceptor`：把 `@Audit()` 标注的 HTTP 处理器自动记进审计表（蓝图 §4.8）。
 *
 * 守卫链/拦截器链的装配顺序在 `apps/api/src/bootstrap/app.module.ts`（T0-8）一处定死
 * （`GlobalAuthGuard → PermissionsGuard → BillingGateGuard → DataScopeInterceptor →
 * AuditInterceptor`，本拦截器在最后）。本包不接 `APP_INTERCEPTOR`，只导出这个类和
 * `provideAuditInterceptor()` 便捷 provider，顺序由 T0-8 决定。
 *
 * **审计写失败不能吞**：`finalize()` 内部调 `AuditService` 失败时，这里 catch 住，打一行
 * error 日志并 `HealthCounters.increment('auditFailures')`，但绝不重新抛出——审计是主业务
 * 的旁路观察者，它挂了不该连累一次本该成功的请求。反过来，`AuditService` 自身不吞异常
 * （见它的文件头），这条分工线才成立。
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
import { ModuleRef, Reflector } from '@nestjs/core'
import {
  AppLogger,
  currentContext,
  HealthCounters,
  redactObject,
  type RequestContext,
} from '@taizan/nest-core'
import type { Request } from 'express'
import { catchError, from, Observable, switchMap, tap, throwError } from 'rxjs'
import { AUDIT_METADATA_KEY, type AuditOptions } from './audit.decorator'
import { AuditService } from './audit.service'
import type { ActorType, AuditOutcome, AuditSnapshot } from './types'

const KIND_TO_ACTOR_TYPE: Record<'platform' | 'staff' | 'member', ActorType> = {
  platform: 'PLATFORM_ADMIN',
  staff: 'STAFF',
  member: 'MEMBER',
}

/**
 * 从 `req.user`（守卫认证成功后惯常挂的字段，`@taizan/nest-auth` 尚未定死其形状）里
 * 找一个能当「操作者名字」用的字符串，找不到就退回 `identity.id`。
 *
 * 这是本包唯一没有上游数据源可以确定拿到的一个字段——`RequestContext.identity` 只有
 * `kind` / `id` / `accountId`，没有名字。见本包 README 级说明「已知未覆盖点」。
 */
export function resolveActorName(req: Request, identity?: RequestContext['identity']): string {
  const user = (req as unknown as { user?: unknown }).user
  if (user && typeof user === 'object') {
    const rec = user as Record<string, unknown>
    for (const key of ['name', 'nickname', 'username']) {
      const value = rec[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return identity?.id ?? 'unknown'
}

/**
 * 平台身份操作时，「这次操作打到了哪家店」依次从 `params.tenantId` /
 * `body.tenantId` / 当前上下文取。
 */
export function resolveTargetTenantId(req: Request, ctx?: RequestContext): string | undefined {
  const params = req.params as Record<string, unknown> | undefined
  const fromParams = params?.tenantId
  if (typeof fromParams === 'string' && fromParams.length > 0) return fromParams

  const body = req.body as Record<string, unknown> | undefined
  const fromBody = body?.tenantId
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody

  return ctx?.tenantId
}

interface FinalizeParams {
  options: AuditOptions
  req: Request
  targetId?: string
  before: unknown
  snapshot?: AuditSnapshot
  outcome: AuditOutcome
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
    @Optional() @Inject(HealthCounters) private readonly healthCounters?: HealthCounters,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle()
    }
    const options = this.reflector.getAllAndOverride<AuditOptions | undefined>(AUDIT_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!options) {
      return next.handle()
    }

    const req = context.switchToHttp().getRequest<Request>()
    const targetId = options.targetId?.(req)
    const snapshot = options.captureBefore ? this.resolveSnapshotProvider(context) : undefined

    return from(this.trySnapshot(snapshot, targetId, 'before')).pipe(
      switchMap((before) =>
        next.handle().pipe(
          tap(() => {
            void this.finalize({ options, req, targetId, before, snapshot, outcome: 'SUCCESS' })
          }),
          catchError((error: unknown) => {
            void this.finalize({ options, req, targetId, before, snapshot, outcome: 'FAIL' })
            return throwError(() => error)
          }),
        ),
      ),
    )
  }

  /** 找 `context.getClass()`（controller）的实例，看它是否实现了 {@link AuditSnapshot}。 */
  private resolveSnapshotProvider(context: ExecutionContext): AuditSnapshot | undefined {
    try {
      const instance = this.moduleRef.get(context.getClass(), { strict: false })
      if (instance && typeof (instance as Partial<AuditSnapshot>).snapshotForAudit === 'function') {
        return instance as AuditSnapshot
      }
    } catch {
      // 拿不到实例（没注册 / 没实现）就当作没有快照能力，走「无快照」的兜底分支。
    }
    return undefined
  }

  /** 快照失败不该炸掉整条请求，只记一行 warn 并当作没拍到。 */
  private async trySnapshot(
    snapshot: AuditSnapshot | undefined,
    targetId: string | undefined,
    phase: 'before' | 'after',
  ): Promise<unknown> {
    if (!snapshot || targetId === undefined) return undefined
    try {
      return await snapshot.snapshotForAudit(targetId)
    } catch (error) {
      this.logger?.warn(
        `@Audit captureBefore 快照失败（${phase}）：${error instanceof Error ? error.message : String(error)}`,
        'AuditInterceptor',
      )
      return undefined
    }
  }

  /**
   * `captureBefore` 打开时用第二次快照当 `after`；否则把（默认脱敏后的）请求体当 `after`。
   * 二选一——见 `audit.decorator.ts` 里 `captureBefore` 选项的说明。
   */
  private async resolveAfter(
    options: AuditOptions,
    req: Request,
    snapshot: AuditSnapshot | undefined,
    targetId: string | undefined,
  ): Promise<unknown> {
    if (options.captureBefore) {
      return this.trySnapshot(snapshot, targetId, 'after')
    }
    const shouldRedact = options.redactBody ?? true
    const body = req.body as unknown
    if (body === undefined) return null
    return shouldRedact ? redactObject(body) : body
  }

  private async finalize(params: FinalizeParams): Promise<void> {
    const { options, req, targetId, before, snapshot, outcome } = params
    const ctx = currentContext()
    const identity = ctx?.identity

    try {
      const after = await this.resolveAfter(options, req, snapshot, targetId)
      const actorName = resolveActorName(req, identity)
      const ip = ctx?.ip.client ?? ''
      const traceId = ctx?.traceId ?? ''

      if (identity?.kind === 'staff' || identity?.kind === 'member') {
        await this.auditService.record({
          action: options.action,
          actorType: KIND_TO_ACTOR_TYPE[identity.kind],
          actorId: identity.id,
          actorName,
          targetType: options.targetType,
          targetId,
          before: before ?? null,
          after: after ?? null,
          ip,
          traceId,
          result: outcome,
        })
        return
      }

      await this.auditService.recordPlatform({
        action: options.action,
        actorType: identity?.kind === 'platform' ? 'PLATFORM_ADMIN' : 'SYSTEM',
        actorId: identity?.id ?? 'anonymous',
        actorName,
        targetType: options.targetType,
        targetId,
        targetTenantId: resolveTargetTenantId(req, ctx),
        before: before ?? null,
        after: after ?? null,
        ip,
        traceId,
        result: outcome,
      })
    } catch (error) {
      this.logger?.error(
        `审计写入失败（action=${options.action}）：${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
        'AuditInterceptor',
      )
      this.healthCounters?.increment('auditFailures')
    }
  }
}
