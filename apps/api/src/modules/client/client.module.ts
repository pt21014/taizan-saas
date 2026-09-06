/**
 * `/api/client` 命名空间的聚合模块（C 端：小程序 / H5 / App）。
 *
 * 这条命名空间**进租户中间件且失败关闭**：用户在登录前就要选店，
 * `X-Tenant-Slug`（仅在这条前缀下生效）与子域名是它唯一的正当用途。
 * 一旦用户登录了，`TokenTenantResolver` 排在链首，请求头里塞别家 slug 不会生效。
 *
 * @packageDocumentation
 */

import { Module } from '@nestjs/common'

import { ClientAuthModule } from './auth/client-auth.module'
import { ClientGoodsModule } from './goods/client-goods.module'

@Module({
  imports: [ClientAuthModule, ClientGoodsModule],
})
export class ClientModule {}
