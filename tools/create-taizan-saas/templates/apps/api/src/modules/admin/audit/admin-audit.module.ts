import { Module } from '@nestjs/common'

import { AdminAuditController } from './audit.controller'
import { AdminAuditService } from './audit.service'

/** 商家侧操作日志（`/api/admin/audit-logs`，只读）。 */
@Module({
  controllers: [AdminAuditController],
  providers: [AdminAuditService],
})
export class AdminAuditModule {}
