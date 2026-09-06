/**
 * `/api/platform/tenants/:id/audit-logs` —— 某个租户的操作审计（T1-7，只读）。
 *
 * 单独一个控制器而不是塞进 `tenant/` 模块：审计查询属于「审计」这个关注点，
 * 与租户 CRUD/启停/续期是两件事，放在 `audit/` 模块统一维护审计相关的读接口。
 * 路由前缀与 `platform-tenant.controller.ts` 相同（`api/platform/tenants`），
 * Nest 按方法签名各自独立注册路由，不会冲突。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Auth } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { ListTenantAuditLogQueryDto } from './dto/audit-log.dto'
import { PlatformAuditService, type TenantAuditLogView } from './platform-audit.service'

@ApiTags('platform/tenants')
@Controller('api/platform/tenants')
@Auth('platform')
export class TenantAuditLogController {
  constructor(@Inject(PlatformAuditService) private readonly audit: PlatformAuditService) {}

  @Get(':tenantId/audit-logs')
  @ApiOperation({ summary: '某个租户的全量操作审计（AuditLog）' })
  list(
    @Param('tenantId') tenantId: string,
    @Query(Validate(ListTenantAuditLogQueryDto)) query: ListTenantAuditLogQueryDto,
  ): Promise<PageResult<TenantAuditLogView>> {
    return this.audit.listForTenant(tenantId, query)
  }
}
