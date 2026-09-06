/**
 * `/api/public/signup` —— 官网自助注册（T1-8）。
 *
 * ## 三个装饰器缺一不可
 *
 * - `@Public()`：注册当然是免登录的。默认拒绝（`GlobalAuthGuard`）下不写它就是 401。
 * - `@RateLimited('signup')`：`@Public()` 必须同时声明档位（蓝图 §8 spec 5，
 *   `guard-default-deny.spec.ts` 静态强制）。这一档 `counts: 'requests'`——
 *   **成功也计数**，因为要拦的恰恰是「每次都成功地建出一家店」。
 * - `@ApiOperation`：这是对外接口，Swagger 上必须说清它不返回 token。
 *
 * `check-slug` 用的是 `lookup` 档而不是 `signup` 档：注册页要边打字边查，
 * 用一天 3 次的档位第四个字就查不动了。`lookup` 拦的是「把库里的店名单抄走」，
 * 10 分钟 30 次，成功也计数。
 *
 * ## 本前缀不进租户中间件
 *
 * `/api/public` 在 `TENANT_FREE_PREFIXES` 里（蓝图 §8 spec 16）：注册的这一刻
 * 租户还不存在，中间件按 slug 找不到租户会失败关闭，把注册页变成 404——
 * 那是 knowledge 上真实发生过的事故。`test/arch/tenant-middleware.spec.ts`
 * 对 `/api/public/signup*` 逐条断言。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public, RateLimited } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { CheckSlugQueryDto, SignupDto } from './dto/signup.dto'
import { SignupService, type CheckSlugResult, type SignupResult } from './signup.service'

@ApiTags('public/signup')
@Controller('api/public/signup')
export class SignupController {
  constructor(@Inject(SignupService) private readonly signups: SignupService) {}

  @Post()
  @Public()
  @RateLimited('signup')
  @ApiOperation({
    summary: '自助注册一家店',
    description:
      '**不返回 token**：注册成功后必须走一次正常登录（`POST /api/admin/auth/login`）。' +
      '在这里签 token 等于开了第三条进后台的路，而登录接口上的验证码、失败限流、' +
      '账号停用判定这里一条都没有。\n\n' +
      '手机号已经开过店时必须填 `existingPassword`（它现有的登录密码），' +
      '验不过什么都不建、也永远不覆盖原口令；失败一律回 `1140100「手机号或密码不对」`，' +
      '不区分「没有这个账号」与「密码不对」——区分了这个接口就是一个手机号枚举器。',
  })
  signup(@Body(Validate(SignupDto)) dto: SignupDto): Promise<SignupResult> {
    return this.signups.signup(dto)
  }

  @Get('check-slug')
  @Public()
  @RateLimited('lookup')
  @ApiOperation({
    summary: '店铺路径查重（形状 + 保留字 + 是否被占用）',
    description: '`lookup` 档：拦的是「把库里的店名单批量抄走」，不是爆破。成功也计数。',
  })
  checkSlug(
    @Query(Validate(CheckSlugQueryDto)) query: CheckSlugQueryDto,
  ): Promise<CheckSlugResult> {
    return this.signups.checkSlug(query.slug)
  }

  @Get('captcha')
  @Public()
  @RateLimited('lookup')
  @ApiOperation({
    summary: '出一张图形验证码（id 随注册表单一起提交回来）',
    description:
      '一次性核销，5 分钟过期。它**不防定向攻击**（打码平台几分钱一个），' +
      '只是把「脚本无脑批量注册」的成本抬上去；真正的防线是 `signup` 档限流。',
  })
  captcha(): Promise<{ id: string; svg: string }> {
    return this.signups.issueCaptcha()
  }
}
