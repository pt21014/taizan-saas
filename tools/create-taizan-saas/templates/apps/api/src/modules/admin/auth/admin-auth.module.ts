import { Module } from '@nestjs/common'

import { AdminAuthController } from './admin-auth.controller'
import { AdminAuthService } from './admin-auth.service'

@Module({
  controllers: [AdminAuthController],
  providers: [AdminAuthService],
  // bootstrap 模块要复用 shopsOf()（一号多店的切换列表）。
  exports: [AdminAuthService],
})
export class AdminAuthModule {}
