/**
 * `/api/admin/audit-logs` —— 商家自己翻本店的操作日志（T1-9，只读）。
 *
 * 全控制器只有一条 `GET`。审计**没有**写接口、更没有删接口——`AuditLog` 由
 * `AuditInterceptor` 在每个挂了 `@Audit` 的路由上自动落库，能被应用层删掉的审计不是审计。
 *
 * `@DataScope` 为什么不挂在这里，见 `audit.service.ts` 的文件头。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'

import { Validate } from '../../../common/validate.pipe'
import { ListAuditLogQueryDto } from './dto/audit.dto'
import { AdminAuditService, type AuditLogView } from './audit.service'

@ApiTags('admin/audit-logs')
@Controller('api/admin/audit-logs')
@Auth('staff')
export class AdminAuditController {
  constructor(@Inject(AdminAuditService) private readonly audit: AdminAuditService) {}

  @Get()
  @ApiOperation({
    summary: '本店操作日志（分页；按动作码 / 模块 / 操作者 / 结果 / 时间段筛）',
    description:
      '只看得到本店的记录——租户条件由 `prisma.tenant` 的隔离扩展注入，' +
      '这一层一个 `tenantId` 都没写，也覆盖不掉。',
  })
  @RequirePermission('audit:list')
  list(
    @Query(Validate(ListAuditLogQueryDto)) query: ListAuditLogQueryDto,
  ): Promise<PageResult<AuditLogView>> {
    return this.audit.list(query)
  }
}
