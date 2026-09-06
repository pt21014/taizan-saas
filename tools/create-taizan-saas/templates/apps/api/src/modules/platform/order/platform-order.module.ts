import { Module } from '@nestjs/common'

import { PlatformOrderController } from './platform-order.controller'
import { PlatformOrderService } from './platform-order.service'

@Module({
  controllers: [PlatformOrderController],
  providers: [PlatformOrderService],
})
export class PlatformOrderModule {}
