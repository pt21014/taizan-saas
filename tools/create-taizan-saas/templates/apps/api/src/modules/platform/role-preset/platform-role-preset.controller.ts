/**
 * `/api/platform/role-presets` —— 内置角色预设 CRUD（T1-7）。
 *
 * @packageDocumentation
 */

import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  CreateRolePresetDto,
  ListRolePresetQueryDto,
  UpdateRolePresetDto,
} from './dto/role-preset.dto'
import { PlatformRolePresetService, type RolePresetView } from './platform-role-preset.service'

function targetIdFromParam(req: { params: Record<string, unknown> }): string | undefined {
  return typeof req.params.id === 'string' ? req.params.id : undefined
}

@ApiTags('platform/role-presets')
@Controller('api/platform/role-presets')
@Auth('platform')
export class PlatformRolePresetController {
  constructor(
    @Inject(PlatformRolePresetService) private readonly presets: PlatformRolePresetService,
  ) {}

  @Get()
  @ApiOperation({ summary: '角色预设列表' })
  list(
    @Query(Validate(ListRolePresetQueryDto)) query: ListRolePresetQueryDto,
  ): Promise<PageResult<RolePresetView>> {
    return this.presets.list(query)
  }

  @Get(':id')
  @ApiOperation({ summary: '角色预设详情' })
  get(@Param('id') id: string): Promise<RolePresetView> {
    return this.presets.get(id)
  }

  @Post()
  @ApiOperation({ summary: '新建角色预设' })
  @Audit({ action: APP_AUDIT_ACTIONS.ROLE_PRESET_CREATE, targetType: 'RolePreset' })
  create(@Body(Validate(CreateRolePresetDto)) dto: CreateRolePresetDto): Promise<RolePresetView> {
    return this.presets.create(dto)
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改角色预设（builtin 禁止）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.ROLE_PRESET_UPDATE,
    targetType: 'RolePreset',
    targetId: targetIdFromParam,
  })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateRolePresetDto)) dto: UpdateRolePresetDto,
  ): Promise<RolePresetView> {
    return this.presets.update(id, dto)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除角色预设（builtin 禁止）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.ROLE_PRESET_DELETE,
    targetType: 'RolePreset',
    targetId: targetIdFromParam,
  })
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.presets.remove(id)
  }
}
