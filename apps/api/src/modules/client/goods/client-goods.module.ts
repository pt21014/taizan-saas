import { Module } from '@nestjs/common'

import { GoodsModule } from '../../example-goods/goods.module'
import { ClientGoodsController } from './client-goods.controller'

@Module({
  imports: [GoodsModule],
  controllers: [ClientGoodsController],
})
export class ClientGoodsModule {}
