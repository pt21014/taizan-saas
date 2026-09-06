/**
 * `/api/platform/audit-logs` —— 平台高危操作审计查询（T1-7，只读）。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Auth } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { ListPlatformAuditLogQueryDto } from './dto/audit-log.dto'
import { PlatformAuditService, type PlatformAuditLogView } from './platform-audit.service'

@ApiTags('platform/audit-logs')
@Controller('api/platform/audit-logs')
@Auth('platform')
export class PlatformAuditLogController {
  constructor(@Inject(PlatformAuditService) private readonly audit: PlatformAuditService) {}

  @Get()
  @ApiOperation({ summary: '平台高危操作审计列表' })
  list(
    @Query(Validate(ListPlatformAuditLogQueryDto)) query: ListPlatformAuditLogQueryDto,
  ): Promise<PageResult<PlatformAuditLogView>> {
    return this.audit.list(query)
  }
}
