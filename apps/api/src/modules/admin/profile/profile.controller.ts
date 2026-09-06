/**
 * `/api/admin/profile` —— 员工的「个人设置」（T1-9）。
 *
 * ## 为什么改密在这里，而不在 `/api/admin/auth`
 *
 * `/api/admin/auth` 是**续费白名单**前缀（`ALWAYS_WRITABLE_PREFIXES`）：套餐到期后
 * 那条前缀下的写操作仍然放行。把改密挂过去等于顺手给它开了到期豁免，
 * 而「到期了还能改密码」不是白名单想解决的问题（白名单存在的唯一理由是让商家能续费）。
 * 放在 `/api/admin/profile` 下，它就和别的后台写操作一样受闸门约束——到期只读时
 * 改不了密码，这是**对的**：那时候商家该做的事只有一件。
 *
 * ## 改密之后前端要做什么
 *
 * 服务端会把这个账号名下**所有店**的会话全撤掉（含当前这一条）。所以前端拿到
 * 成功响应后应当立刻 `session.logout()` 并跳登录页——不跳的话下一个请求会拿到
 * 1140100，用户看到的是一次莫名其妙的掉线。`apps/admin` 的 `ProfileSettingsPage`
 * 已经是这么写的（那一段行为不是 mock）。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Patch, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Audit } from '@taizan/nest-audit'
import { Auth, CurrentUser, type AuthPrincipal } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import { ChangePasswordDto, UpdateProfileDto } from './dto/profile.dto'
import { AdminProfileService, type ChangePasswordResult, type ProfileView } from './profile.service'

@ApiTags('admin/profile')
@Controller('api/admin/profile')
@Auth('staff')
export class AdminProfileController {
  constructor(@Inject(AdminProfileService) private readonly profile: AdminProfileService) {}

  @Get()
  @ApiOperation({ summary: '我的资料：账号（显示名/头像/手机号）+ 当前店里的身份' })
  @RequirePermission('profile:read')
  get(@CurrentUser() user: AuthPrincipal): Promise<ProfileView> {
    return this.profile.get(user)
  }

  @Patch()
  @ApiOperation({ summary: '改显示名 / 头像（账号级，一号多店时所有店的顶栏一起变）' })
  @RequirePermission('profile:write')
  @Audit({ action: APP_AUDIT_ACTIONS.PROFILE_UPDATE, targetType: 'StaffAccount' })
  update(
    @CurrentUser() user: AuthPrincipal,
    @Body(Validate(UpdateProfileDto)) dto: UpdateProfileDto,
  ): Promise<ProfileView> {
    return this.profile.update(user, dto)
  }

  @Post('change-password')
  @ApiOperation({
    summary: '改密码（验旧密码 → 改 → **全端撤销会话**，前端应当立刻登出）',
    description: '一号多店时会把这个账号名下所有店的会话一起撤掉，不只是当前这一家。',
  })
  @RequirePermission('profile:write')
  @Audit({
    action: APP_AUDIT_ACTIONS.PROFILE_CHANGE_PASSWORD,
    targetType: 'StaffAccount',
    // 请求体里有两个明文口令，绝不能落进审计表。
    redactBody: true,
  })
  changePassword(
    @CurrentUser() user: AuthPrincipal,
    @Body(Validate(ChangePasswordDto)) dto: ChangePasswordDto,
  ): Promise<ChangePasswordResult> {
    return this.profile.changePassword(user, dto)
  }
}
