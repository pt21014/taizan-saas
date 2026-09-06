import { Module } from '@nestjs/common'

import { AdminProfileController } from './profile.controller'
import { AdminProfileService } from './profile.service'

/** 「个人设置」（`/api/admin/profile`）。`SessionService` 由 `@Global()` 的 `AuthModule` 提供。 */
@Module({
  controllers: [AdminProfileController],
  providers: [AdminProfileService],
})
export class AdminProfileModule {}
