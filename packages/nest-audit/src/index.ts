/**
 * `@taizan/nest-audit`：审计（蓝图 §4.8）。
 *
 * - `defineAuditActions()` / `AUDIT_ACTIONS`：动作码常量与格式校验。
 * - `@Audit()`：标注控制器方法，交给 `AuditInterceptor` 自动记录。
 * - `AuditInterceptor`：只处理带 `@Audit()` 的 HTTP 处理器，写失败不吞（打 error +
 *   计数 `HealthCounters.auditFailures`），不影响主响应。
 * - `AuditService`：手动补充审计（事务内 / cron / 队列等非 HTTP 场景），本身不吞异常。
 * - `AuditModule.forRoot()` + `provideAuditInterceptor()`：装配入口，拦截器接线顺序
 *   由 `apps/api/src/bootstrap/app.module.ts`（T0-8）决定。
 *
 * @packageDocumentation
 */

export { AUDIT_ACTIONS, defineAuditActions } from './actions'
export { Audit, AUDIT_METADATA_KEY, type AuditOptions } from './audit.decorator'
export { AuditInterceptor, resolveActorName, resolveTargetTenantId } from './audit.interceptor'
export { AuditModule, provideAuditInterceptor } from './audit.module'
export { AuditService } from './audit.service'
export type {
  ActorType,
  AuditEntry,
  AuditOutcome,
  AuditSnapshot,
  PlatformAuditEntry,
} from './types'
