/**
 * `/api/platform/admins/me/mfa` —— 平台管理员自己的 MFA 开关位（T3-4 任务书条目⑤）。
 *
 * 只做「开关位」这一半，见 `platform-mfa.service.ts` 文件头的范围说明——登录时是否
 * 强制要求 `totp` 仍是 TODO，本文件两个接口只是让管理员能生成/验证一份 TOTP 密钥。
 *
 * @packageDocumentation
 */

import { Body, Controller, Inject, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Audit } from '@taizan/nest-audit'
import { Auth, CurrentUser, type AuthPrincipal } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import { VerifyMfaDto } from './dto/platform-mfa.dto'
import {
  PlatformMfaService,
  type MfaEnableResult,
  type MfaVerifyResult,
} from './platform-mfa.service'

@ApiTags('platform/auth')
@Controller('api/platform/admins/me/mfa')
@Auth('platform')
export class PlatformMfaController {
  constructor(@Inject(PlatformMfaService) private readonly mfa: PlatformMfaService) {}

  @Post('enable')
  @ApiOperation({ summary: '生成一份新 TOTP secret 并加密落库，返回 otpauth URL 供扫码' })
  @Audit({ action: APP_AUDIT_ACTIONS.PLATFORM_ADMIN_MFA_ENABLE, targetType: 'PlatformAdmin' })
  enable(@CurrentUser() user: AuthPrincipal): Promise<MfaEnableResult> {
    return this.mfa.enable(user.id)
  }

  @Post('verify')
  @ApiOperation({ summary: '校验一枚 TOTP 一次性码' })
  @Audit({ action: APP_AUDIT_ACTIONS.PLATFORM_ADMIN_MFA_VERIFY, targetType: 'PlatformAdmin' })
  verify(
    @CurrentUser() user: AuthPrincipal,
    @Body(Validate(VerifyMfaDto)) dto: VerifyMfaDto,
  ): Promise<MfaVerifyResult> {
    return this.mfa.verify(user.id, dto.code)
  }
}
