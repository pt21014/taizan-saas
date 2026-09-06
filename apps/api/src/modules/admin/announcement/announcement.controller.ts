/**
 * `/api/admin/announcements` —— 商家看**平台发来的**公告（T1-9）。
 *
 * 与 `apps/admin/src/api/announcements.ts` 那份 mock 的方向刻意不同：mock 里写的是
 * 「商家自己发店内公告」的 CRUD，但那需要一张新的租户域表（`06-ops.prisma` 里的
 * `Announcement` 是平台域的）。本任务落的是**平台 → 商家**这个方向，也就是
 * `AnnouncementList` 这一页真正该有的内容；「店内公告」是一个独立的业务需求，
 * 要走七件事的完整流程（先加表）。前端接线时按本文件的形状改 mock。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Param, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth, CurrentUser, type AuthPrincipal } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'
import type { Request } from 'express'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import { ListAnnouncementQueryDto } from './dto/announcement.dto'
import { AdminAnnouncementService, type AnnouncementView } from './announcement.service'

@ApiTags('admin/announcements')
@Controller('api/admin/announcements')
@Auth('staff')
export class AdminAnnouncementController {
  constructor(
    @Inject(AdminAnnouncementService) private readonly announcements: AdminAnnouncementService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '本店可见的平台公告（已发布 + 在有效期内 + audience 命中），附本人已读状态',
    description:
      'audience 三档：`ALL_TENANT` 全部租户 / `PLAN` 指定套餐 / `TENANT_IDS` 指定租户。' +
      '`C_END`（给会员看的）在商家后台一律不显示。',
  })
  @RequirePermission('announcement:list')
  list(
    @CurrentUser() user: AuthPrincipal,
    @Query(Validate(ListAnnouncementQueryDto)) query: ListAnnouncementQueryDto,
  ): Promise<PageResult<AnnouncementView>> {
    return this.announcements.list(user, query)
  }

  @Post(':id/read')
  @ApiOperation({
    summary: '标记已读（幂等；重复调用不刷新首次已读时间）',
    description: '写的是**读者自己的**一条回执，所以不单列权限点，看得到就标得了。',
  })
  @RequirePermission('announcement:list')
  @Audit({
    action: APP_AUDIT_ACTIONS.ANNOUNCEMENT_READ,
    targetType: 'Announcement',
    // express 5 的 `params` 值类型是 `string | string[]`；`as string` 会把数组也放过去。
    targetId: (req: Request) => (typeof req.params.id === 'string' ? req.params.id : undefined),
  })
  markRead(
    @CurrentUser() user: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<{ readAt: string }> {
    return this.announcements.markRead(user, id)
  }
}
