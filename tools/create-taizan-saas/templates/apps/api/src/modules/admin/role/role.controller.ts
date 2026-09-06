/**
 * `/api/admin/roles` —— 商家自定义角色（T1-9）。
 *
 * ## 路由顺序
 *
 * `GET /permissions`（权限点目录）**必须声明在 `GET /:id` 之类的参数路由之前**。
 * 本控制器目前没有 `GET /:id`，但顺序先摆对——加的时候不会踩。
 *
 * ## 权限点目录为什么是一条独立路由，而不是塞进 bootstrap
 *
 * bootstrap 下发的 `permissions` 是「**我**有哪些权限」，角色编辑页要的是
 * 「这个系统里**一共**有哪些权限可以勾」。两者的读者不同、变更频率不同、
 * 大小也差一个量级（后者是全量注册表）。塞进 bootstrap 会让每个人每次登录
 * 都多下载一份他八成用不到的目录。
 *
 * @packageDocumentation
 */

import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'
import type { Request } from 'express'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import { CreateRoleDto, ListRoleQueryDto, UpdateRoleDto } from './dto/role.dto'
import { AdminRoleService, type PermissionCatalogGroup, type RoleView } from './role.service'

/** express 5 的 `params` 值类型是 `string | string[]`；`as string` 会把数组也放过去。 */
function idOf(req: Request): string | undefined {
  return typeof req.params.id === 'string' ? req.params.id : undefined
}

@ApiTags('admin/roles')
@Controller('api/admin/roles')
@Auth('staff')
export class AdminRoleController {
  constructor(@Inject(AdminRoleService) private readonly roles: AdminRoleService) {}

  @Get('permissions')
  @ApiOperation({
    summary: '可勾选的权限点目录（按模块分组，已滤掉 platform-* 那批）',
    description:
      '真源是代码里的权限点注册表，不是 `Permission` 表——那张表只是镜像，' +
      '同步命令没跑的环境上它可能是旧的。',
  })
  @RequirePermission('role:list')
  catalog(): PermissionCatalogGroup[] {
    return this.roles.catalog()
  }

  @Get()
  @ApiOperation({ summary: '角色列表（分页；带每个角色当前挂着几个人）' })
  @RequirePermission('role:list')
  list(@Query(Validate(ListRoleQueryDto)) query: ListRoleQueryDto): Promise<PageResult<RoleView>> {
    return this.roles.list(query)
  }

  @Post()
  @ApiOperation({ summary: '新建角色' })
  @RequirePermission('role:write')
  @Audit({ action: APP_AUDIT_ACTIONS.ROLE_CREATE, targetType: 'Role' })
  create(@Body(Validate(CreateRoleDto)) dto: CreateRoleDto): Promise<RoleView> {
    return this.roles.create(dto)
  }

  @Patch(':id')
  @ApiOperation({ summary: '改角色（内置角色不可改 code）；改完权限点立刻生效' })
  @RequirePermission('role:write')
  @Audit({ action: APP_AUDIT_ACTIONS.ROLE_UPDATE, targetType: 'Role', targetId: idOf })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateRoleDto)) dto: UpdateRoleDto,
  ): Promise<RoleView> {
    return this.roles.update(id, dto)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删角色（软删）；内置的、以及还有人挂着的都删不掉' })
  @RequirePermission('role:delete')
  @Audit({ action: APP_AUDIT_ACTIONS.ROLE_DELETE, targetType: 'Role', targetId: idOf })
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.roles.remove(id)
  }
}
