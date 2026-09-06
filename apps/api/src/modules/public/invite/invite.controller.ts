/**
 * `/api/public/invites/:token` —— 被邀请人这一侧（T1-9）。
 *
 * ## 两个装饰器缺一不可
 *
 * - `@Public()`：被邀请人还没有账号，当然得免登录。默认拒绝（`GlobalAuthGuard`）下
 *   不写它就是 401。
 * - `@RateLimited(tier)`：`@Public()` 必须同时声明档位（蓝图 §8 spec 5，
 *   `guard-default-deny.spec.ts` 静态强制）。
 *
 * 两条路由的档位刻意不同：
 *
 * | 路由 | 档位 | 拦的是什么 |
 * |---|---|---|
 * | `GET /:token` | `lookup` | 拿一堆随机令牌**批量探**「哪家店存在、限定了哪个手机号」 |
 * | `POST /:token/accept` | `signup` | 「每次都成功地多出一个员工」——与自助注册同一类，成功也计数 |
 *
 * 用 `login` 档是不对的：那一档 `counts: 'failures'`，只算失败，而这里要拦的行为每次都成功。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public, RateLimited } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { AcceptInviteDto } from './dto/invite.dto'
import { InviteService, type AcceptInviteResult, type InviteLookupResult } from './invite.service'

@ApiTags('public/invites')
@Controller('api/public/invites')
export class InviteController {
  constructor(@Inject(InviteService) private readonly invites: InviteService) {}

  @Get(':token')
  @Public()
  @RateLimited('lookup')
  @ApiOperation({
    summary: '查一张员工邀请还能不能用（无效也返回 200，带 reason）',
    description:
      '有效时下发店名与**打码后**的限定手机号；无效时连店名都不下发——' +
      '否则乱猜令牌就能把平台上的店名单抄走。',
  })
  lookup(@Param('token') token: string): Promise<InviteLookupResult> {
    return this.invites.lookup(token)
  }

  @Post(':token/accept')
  @Public()
  @RateLimited('signup')
  @ApiOperation({
    summary: '接受邀请，加入这家店（**不返回 token**）',
    description:
      '手机号已经有账号时，`password` 必须是它现有的登录密码——验不过什么都不建，' +
      '也永远不覆盖原口令；失败一律回 `1140100`，不区分「没有这个账号」与「密码不对」。\n\n' +
      '加入成功会占用一个 `STAFF` 配额，满了回 `1540301`。' +
      '成功后请跳登录页走一次正常登录（`POST /api/admin/auth/login`）。',
  })
  accept(
    @Param('token') token: string,
    @Body(Validate(AcceptInviteDto)) dto: AcceptInviteDto,
  ): Promise<AcceptInviteResult> {
    return this.invites.accept(token, dto)
  }
}
