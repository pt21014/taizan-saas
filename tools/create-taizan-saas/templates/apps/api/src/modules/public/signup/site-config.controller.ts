/**
 * `GET /api/public/site-config` —— 官网落地页要的那点配置（T1-8）。
 *
 * ## 为什么套餐价格要现取，而不是让官网自己写一份
 *
 * 官网上的价目表和 `Plan` 表如果是两份，改一次价必然只改一边——而漂掉的那一边
 * 是**商家看到的价格**。商家按官网的价点进来，下单时金额对不上，
 * 客服要解释半天，最后还得按哪个价收也说不清。所以这里现查 `Plan`，
 * 官网只负责渲染。`test/signup.e2e-spec.ts` 用「平台后台新建一个套餐 →
 * 这个接口立刻能看到它、且价格逐字段一致」把这条钉住。
 *
 * ## 为什么注册开关也在这里
 *
 * `POST /signup` 与本接口读的是**同一个** `isSignupOpen()`。各判各的话，
 * 迟早出现「官网上注册按钮还在、点进去报『暂未开放』」。
 *
 * 档位用 `public-default`（公开只读接口的兜底档）：它既不是查重也不是注册，
 * 防的只是「把公开接口当免费 CDN 刷」。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Public, RateLimited } from '@taizan/nest-auth'

import { SignupService, type SiteConfig } from './signup.service'

@ApiTags('public/site-config')
@Controller('api/public')
export class SiteConfigController {
  constructor(@Inject(SignupService) private readonly signups: SignupService) {}

  @Get('site-config')
  @Public()
  @RateLimited('public-default')
  @ApiOperation({
    summary: '站点配置：注册开关、试用天数、在售套餐（价格现取自 Plan 表）',
  })
  siteConfig(): Promise<SiteConfig> {
    return this.signups.siteConfig()
  }
}
