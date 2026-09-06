import { Module } from '@nestjs/common'

import { AdminAuthModule } from '../auth/admin-auth.module'
import { BootstrapAliasController, BootstrapController } from './bootstrap.controller'
import { BootstrapService } from './bootstrap.service'

@Module({
  imports: [AdminAuthModule],
  controllers: [BootstrapController, BootstrapAliasController],
  providers: [BootstrapService],
})
export class AdminBootstrapModule {}
