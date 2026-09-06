import { Module } from '@nestjs/common'

import { PlatformAuditLogController } from './platform-audit-log.controller'
import { PlatformAuditService } from './platform-audit.service'
import { TenantAuditLogController } from './tenant-audit-log.controller'

@Module({
  controllers: [PlatformAuditLogController, TenantAuditLogController],
  providers: [PlatformAuditService],
})
export class PlatformAuditModule {}
