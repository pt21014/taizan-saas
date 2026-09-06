/**
 * `/api/platform/admins` —— 平台管理员 CRUD（T1-7）。
 *
 * 全部 `@Auth('platform')`：只接受平台超管 token，没有 `@Public()`。
 * 高危操作（新建/改角色/重置口令/启停）都挂 `@Audit`。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth, CurrentUser, type AuthPrincipal } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  CreateAdminDto,
  ListAdminQueryDto,
  SetAdminPasswordDto,
  UpdateAdminDto,
} from './dto/platform-admin.dto'
import {
  PlatformAdminService,
  type AdminSecretResult,
  type AdminView,
} from './platform-admin.service'

@ApiTags('platform/admins')
@Controller('api/platform/admins')
@Auth('platform')
export class PlatformAdminController {
  constructor(@Inject(PlatformAdminService) private readonly admins: PlatformAdminService) {}

  @Get()
  @ApiOperation({ summary: '平台管理员列表' })
  list(
    @Query(Validate(ListAdminQueryDto)) query: ListAdminQueryDto,
  ): Promise<PageResult<AdminView>> {
    return this.admins.list(query)
  }

  @Get(':id')
  @ApiOperation({ summary: '平台管理员详情' })
  get(@Param('id') id: string): Promise<AdminView> {
    return this.admins.get(id)
  }

  @Post()
  @ApiOperation({ summary: '新建平台管理员' })
  @Audit({ action: APP_AUDIT_ACTIONS.PLATFORM_ADMIN_CREATE, targetType: 'PlatformAdmin' })
  create(@Body(Validate(CreateAdminDto)) dto: CreateAdminDto): Promise<AdminSecretResult> {
    return this.admins.create(dto)
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改平台管理员（名字 / 角色）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.PLATFORM_ADMIN_UPDATE,
    targetType: 'PlatformAdmin',
    targetId: (req) => (typeof req.params.id === 'string' ? req.params.id : undefined),
  })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateAdminDto)) dto: UpdateAdminDto,
  ): Promise<AdminView> {
    return this.admins.update(id, dto)
  }

  @Patch(':id/password')
  @ApiOperation({ summary: '重置管理员登录口令（重置后旧 token 立即失效）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.PLATFORM_ADMIN_RESET_PASSWORD,
    targetType: 'PlatformAdmin',
    targetId: (req) => (typeof req.params.id === 'string' ? req.params.id : undefined),
    // 请求体带口令，绝不能落进审计表——哪怕脱敏之后也不该留痕明文口令的字段名以外的东西。
    redactBody: true,
  })
  setPassword(
    @Param('id') id: string,
    @Body(Validate(SetAdminPasswordDto)) dto: SetAdminPasswordDto,
  ): Promise<AdminSecretResult> {
    return this.admins.setPassword(id, dto)
  }

  @Patch(':id/enable')
  @ApiOperation({ summary: '启用管理员' })
  @Audit({
    action: APP_AUDIT_ACTIONS.PLATFORM_ADMIN_ENABLE,
    targetType: 'PlatformAdmin',
    targetId: (req) => (typeof req.params.id === 'string' ? req.params.id : undefined),
  })
  enable(@Param('id') id: string): Promise<AdminView> {
    return this.admins.enable(id)
  }

  @Patch(':id/disable')
  @ApiOperation({ summary: '停用管理员（不能停用自己 / 不能停用最后一个 ACTIVE）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.PLATFORM_ADMIN_DISABLE,
    targetType: 'PlatformAdmin',
    targetId: (req) => (typeof req.params.id === 'string' ? req.params.id : undefined),
  })
  disable(@Param('id') id: string, @CurrentUser() actingAdmin: AuthPrincipal): Promise<AdminView> {
    return this.admins.disable(id, actingAdmin.id)
  }
}
