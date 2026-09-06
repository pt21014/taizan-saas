import { Module } from '@nestjs/common'

import { PlatformRolePresetController } from './platform-role-preset.controller'
import { PlatformRolePresetService } from './platform-role-preset.service'

@Module({
  controllers: [PlatformRolePresetController],
  providers: [PlatformRolePresetService],
})
export class PlatformRolePresetModule {}
