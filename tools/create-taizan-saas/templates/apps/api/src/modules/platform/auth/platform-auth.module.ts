import { Module } from '@nestjs/common'

import { PlatformAuthController } from './platform-auth.controller'
import { PlatformAuthService } from './platform-auth.service'
import { PlatformMfaController } from './platform-mfa.controller'
import { PlatformMfaService } from './platform-mfa.service'

@Module({
  controllers: [PlatformAuthController, PlatformMfaController],
  providers: [PlatformAuthService, PlatformMfaService],
})
export class PlatformAuthModule {}
