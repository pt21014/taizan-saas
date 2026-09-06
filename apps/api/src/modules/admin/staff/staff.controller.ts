/**
 * `/api/admin/staff` —— 商家后台的员工管理（T1-9）。
 *
 * ## 路由顺序有讲究
 *
 * `POST /invites` 与 `POST /transfer-owner` 都必须**声明在任何 `:id` 路由之前**。
 * Nest 按声明顺序匹配，反过来写的话 `/invites` 会先命中 `:id`，
 * 表现是「邀请按钮返回 1240300 员工不存在」——一个查半天才想得到的症状。
 * 本控制器现在没有 `POST /:id`，但保持这个顺序是为了将来加的时候不会踩。
 *
 * ## 每个写操作都挂了 `@Audit`
 *
 * 员工变更是最典型的「事后要查是谁干的」：谁把谁停了、谁给谁加了权限、店是谁转的。
 * 四个动作码里三个来自框架内置的 `AUDIT_ACTIONS`（`staff.invite` / `staff.role-change`
 * / `staff.owner-transfer`），启停两个是本应用补的——框架没有内置它们。
 *
 * ## 没有「删除员工」
 *
 * 只有停用。软删一个 `Staff` 行会让他名下的历史单据失去操作人（`AuditLog.actorId`
 * 指向一个查不到的 id），而商家真正想要的从来是「他不能再登进来」，那就是 `DISABLED`。
 * 框架内置的 `staff.remove` 动作码留给将来真的需要「移出店铺」时用。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit, AUDIT_ACTIONS } from '@taizan/nest-audit'
import { Auth, CurrentUser, type AuthPrincipal } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'
import type { Request } from 'express'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  CreateStaffInviteDto,
  ListStaffQueryDto,
  TransferOwnerDto,
  UpdateStaffDto,
} from './dto/staff.dto'
import {
  AdminStaffService,
  type StaffInviteView,
  type StaffView,
  type TransferOwnerResult,
} from './staff.service'

/** express 5 的 `params` 值类型是 `string | string[]`；`as string` 会把数组也放过去。 */
function idOf(req: Request): string | undefined {
  return typeof req.params.id === 'string' ? req.params.id : undefined
}

@ApiTags('admin/staff')
@Controller('api/admin/staff')
@Auth('staff')
export class AdminStaffController {
  constructor(@Inject(AdminStaffService) private readonly staff: AdminStaffService) {}

  @Get()
  @ApiOperation({ summary: '员工列表（分页；关键字同时匹配店内昵称与登录手机号）' })
  @RequirePermission('staff:list')
  list(
    @Query(Validate(ListStaffQueryDto)) query: ListStaffQueryDto,
  ): Promise<PageResult<StaffView>> {
    return this.staff.list(query)
  }

  @Post('invites')
  @ApiOperation({
    summary: '生成一张员工邀请（**不扣配额**，配额在被邀请人接受时才扣）',
    description:
      '返回的 `token` 本身就是凭证：拿到链接的人就能加入这家店。' +
      '不填 `phone` 时任何人凭链接可入，填了则只有那个手机号能核销。',
  })
  @RequirePermission('staff:invite')
  @Audit({ action: AUDIT_ACTIONS.STAFF_INVITE, targetType: 'StaffInvite' })
  createInvite(
    @CurrentUser() user: AuthPrincipal,
    @Body(Validate(CreateStaffInviteDto)) dto: CreateStaffInviteDto,
  ): Promise<StaffInviteView> {
    return this.staff.createInvite(user, dto)
  }

  @Post('transfer-owner')
  @ApiOperation({
    summary: '转让店主（仅店主本人可调；转让后自己降为店长角色）',
    description: '店主身份不是一个可勾选的角色（`ASSIGNABLE_ROLE_RULE`），只能通过这条路由转移。',
  })
  @RequirePermission('staff:transfer-owner')
  @Audit({ action: AUDIT_ACTIONS.STAFF_OWNER_TRANSFER, targetType: 'Staff' })
  transferOwner(
    @CurrentUser() user: AuthPrincipal,
    @Body(Validate(TransferOwnerDto)) dto: TransferOwnerDto,
  ): Promise<TransferOwnerResult> {
    return this.staff.transferOwner(user, dto)
  }

  @Patch(':id')
  @ApiOperation({ summary: '改员工（店内昵称 / 角色）；改完角色立刻生效，不用等缓存过期' })
  @RequirePermission('staff:write')
  @Audit({
    action: AUDIT_ACTIONS.STAFF_ROLE_CHANGE,
    targetType: 'Staff',
    targetId: idOf,
  })
  update(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
    @Body(Validate(UpdateStaffDto)) dto: UpdateStaffDto,
  ): Promise<StaffView> {
    return this.staff.update(user, id, dto)
  }

  @Post(':id/disable')
  @ApiOperation({ summary: '停用员工（不能停自己、不能停店主）；≤30 秒内他的请求变 401' })
  @RequirePermission('staff:disable')
  @Audit({ action: APP_AUDIT_ACTIONS.STAFF_DISABLE, targetType: 'Staff', targetId: idOf })
  disable(@CurrentUser() user: AuthPrincipal, @Param('id') id: string): Promise<StaffView> {
    return this.staff.setStatus(user, id, 'DISABLED')
  }

  @Post(':id/enable')
  @ApiOperation({ summary: '启用员工' })
  @RequirePermission('staff:disable')
  @Audit({ action: APP_AUDIT_ACTIONS.STAFF_ENABLE, targetType: 'Staff', targetId: idOf })
  enable(@CurrentUser() user: AuthPrincipal, @Param('id') id: string): Promise<StaffView> {
    return this.staff.setStatus(user, id, 'ACTIVE')
  }
}
