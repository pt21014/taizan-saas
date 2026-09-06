import { Module } from '@nestjs/common'

import { AdminAnnouncementController } from './announcement.controller'
import { AdminAnnouncementService } from './announcement.service'

/**
 * 商家侧「平台公告」（`/api/admin/announcements`）。
 *
 * 不 `imports: [BillingModule]`——`@taizan/nest-billing` 是 `@Global()` 的，
 * `PLATFORM_GATEWAY`（用来拿本店 planCode，判 `audience = PLAN`）直接注入即可。
 */
@Module({
  controllers: [AdminAnnouncementController],
  providers: [AdminAnnouncementService],
})
export class AdminAnnouncementModule {}
