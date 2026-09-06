/**
 * `/api/public` 命名空间的装配。
 *
 * T1-8 起这里多了自助注册那三个控制器，T1-9 起多了员工邀请的核销端。
 * 它们与 `PublicController` 平级列在这里而不是各起一个子模块：`/api/public` 下的
 * 东西都是同一类（免登录、免租户、对外），多一层模块只多一层间接。
 *
 * `InviteService` 是唯一一个有自己 service 文件的例外，因为核销逻辑（抢占令牌、
 * 扣配额、补偿）比一个控制器方法该有的长度长得多。
 *
 * @packageDocumentation
 */

import { Module } from '@nestjs/common'

import { InviteController } from './invite/invite.controller'
import { InviteService } from './invite/invite.service'
import { PublicController } from './public.controller'
import { SignupController } from './signup/signup.controller'
import { SignupService } from './signup/signup.service'
import { SiteConfigController } from './signup/site-config.controller'

@Module({
  controllers: [PublicController, SignupController, SiteConfigController, InviteController],
  providers: [SignupService, InviteService],
})
export class PublicModule {}
