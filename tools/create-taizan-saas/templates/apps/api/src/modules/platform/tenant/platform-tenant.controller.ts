/**
 * `/api/platform/tenants` —— 平台后台的租户管理（T0-8 只做「开通」与「列表」）。
 *
 * `@Auth('platform')`：只接受平台超管 token。没有 `@Public()`，所以默认拒绝。
 * `@Audit`：开通租户是高危操作，写 `PlatformAuditLog`（平台身份 → 平台表，
 * 由 `AuditInterceptor` 按 `identity.kind` 自动分流）。
 *
 * T1-7 新增的这批子路由（冻结/解冻/续期/改套餐/重置店主口令/注销）统一用
 * `:tenantId` 而不是 `:id` 当路由参数名——`@taizan/nest-audit` 的
 * `resolveTargetTenantId()` 按 `req.params.tenantId` 自动把「这次操作打到了哪家店」
 * 填进 `PlatformAuditLog.targetTenantId`，参数名对不上这个约定它就只能落空。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit, AUDIT_ACTIONS } from '@taizan/nest-audit'
import { Auth, CurrentUser, type AuthPrincipal } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  ChangeTenantPlanDto,
  CreateTenantDto,
  ListTenantQueryDto,
  RenewTenantDto,
  ResetOwnerPasswordDto,
} from './dto/platform-tenant.dto'
import {
  PlatformTenantService,
  type CreateTenantResult,
  type RenewTenantResult,
  type ResetOwnerPasswordResult,
  type TenantOverview,
  type TenantView,
} from './platform-tenant.service'

/** `:tenantId/xxx` 路由公用的 `targetId` 取值函数——express 5 的 `params` 值可能是数组。 */
function targetIdFromParam(req: { params: Record<string, unknown> }): string | undefined {
  return typeof req.params.tenantId === 'string' ? req.params.tenantId : undefined
}

@ApiTags('platform/tenants')
@Controller('api/platform/tenants')
@Auth('platform')
export class PlatformTenantController {
  constructor(@Inject(PlatformTenantService) private readonly tenants: PlatformTenantService) {}

  @Get()
  @ApiOperation({ summary: '租户列表' })
  list(
    @Query(Validate(ListTenantQueryDto)) query: ListTenantQueryDto,
  ): Promise<PageResult<TenantView>> {
    return this.tenants.list(query)
  }

  @Get(':tenantId/overview')
  @ApiOperation({ summary: '租户看板：员工/会员/商品数（全部 count，不拖全表）' })
  overview(@Param('tenantId') tenantId: string): Promise<TenantOverview> {
    return this.tenants.overview(tenantId)
  }

  /**
   * 开通一家店。整块走 `@taizan/provision`（T1-8）。
   *
   * `operatorId` 必传给 service：`provisionTenant()` 对 `source: 'PLATFORM'`
   * 强制要求它（谁开的店必须留痕），漏了会抛 `OPERATOR_REQUIRED`。
   */
  @Post()
  @ApiOperation({ summary: '开通一家店（走 @taizan/provision 单一路径）' })
  @Audit({ action: AUDIT_ACTIONS.TENANT_CREATE, targetType: 'Tenant' })
  create(
    @Body(Validate(CreateTenantDto)) dto: CreateTenantDto,
    @CurrentUser() admin: AuthPrincipal,
  ): Promise<CreateTenantResult> {
    return this.tenants.create(dto, admin.id)
  }

  @Patch(':tenantId/suspend')
  @ApiOperation({ summary: '冻结（暂停）一家店' })
  @Audit({
    action: AUDIT_ACTIONS.TENANT_SUSPEND,
    targetType: 'Tenant',
    targetId: targetIdFromParam,
  })
  suspend(@Param('tenantId') tenantId: string): Promise<TenantView> {
    return this.tenants.suspend(tenantId)
  }

  @Patch(':tenantId/resume')
  @ApiOperation({ summary: '解冻（恢复）一家店' })
  @Audit({ action: AUDIT_ACTIONS.TENANT_RESUME, targetType: 'Tenant', targetId: targetIdFromParam })
  resume(@Param('tenantId') tenantId: string): Promise<TenantView> {
    return this.tenants.resume(tenantId)
  }

  @Patch(':tenantId/renew')
  @ApiOperation({ summary: '续期（TODO(T1-5)：改走统一 fulfill 路径前的临时形状）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.TENANT_RENEW,
    targetType: 'Tenant',
    targetId: targetIdFromParam,
  })
  renew(
    @Param('tenantId') tenantId: string,
    @Body(Validate(RenewTenantDto)) dto: RenewTenantDto,
    @CurrentUser() admin: AuthPrincipal,
  ): Promise<RenewTenantResult> {
    return this.tenants.renew(tenantId, dto, admin.id)
  }

  @Patch(':tenantId/change-plan')
  @ApiOperation({ summary: '更换套餐（不改到期日）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.TENANT_CHANGE_PLAN,
    targetType: 'Tenant',
    targetId: targetIdFromParam,
  })
  changePlan(
    @Param('tenantId') tenantId: string,
    @Body(Validate(ChangeTenantPlanDto)) dto: ChangeTenantPlanDto,
  ): Promise<TenantView> {
    return this.tenants.changePlan(tenantId, dto)
  }

  @Patch(':tenantId/reset-owner-password')
  @ApiOperation({ summary: '重置店主登录口令（重置后旧 token 立即失效）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.TENANT_RESET_OWNER_PASSWORD,
    targetType: 'Tenant',
    targetId: targetIdFromParam,
  })
  resetOwnerPassword(
    @Param('tenantId') tenantId: string,
    @Body(Validate(ResetOwnerPasswordDto)) dto: ResetOwnerPasswordDto,
  ): Promise<ResetOwnerPasswordResult> {
    return this.tenants.resetOwnerPassword(tenantId, dto)
  }

  @Patch(':tenantId/deregister')
  @ApiOperation({ summary: '注销一家店（只置状态位 + 保留期，无物理删除）' })
  @Audit({
    action: AUDIT_ACTIONS.TENANT_DEREGISTER,
    targetType: 'Tenant',
    targetId: targetIdFromParam,
  })
  deregister(@Param('tenantId') tenantId: string): Promise<TenantView> {
    return this.tenants.deregister(tenantId)
  }
}
