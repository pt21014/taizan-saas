import { Module } from '@nestjs/common'

import { PlatformAnnouncementController } from './platform-announcement.controller'
import { PlatformAnnouncementService } from './platform-announcement.service'

@Module({
  controllers: [PlatformAnnouncementController],
  providers: [PlatformAnnouncementService],
})
export class PlatformAnnouncementModule {}
