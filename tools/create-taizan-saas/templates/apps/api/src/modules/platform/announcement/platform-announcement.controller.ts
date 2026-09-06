/**
 * `/api/platform/announcements` —— 平台公告 CRUD + 发布/下线 + 已读统计（T1-7）。
 *
 * @packageDocumentation
 */

import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit, AUDIT_ACTIONS } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import {
  CreateAnnouncementDto,
  ListAnnouncementQueryDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto'
import {
  PlatformAnnouncementService,
  type AnnouncementReadStats,
  type AnnouncementView,
} from './platform-announcement.service'

function targetIdFromParam(req: { params: Record<string, unknown> }): string | undefined {
  return typeof req.params.id === 'string' ? req.params.id : undefined
}

@ApiTags('platform/announcements')
@Controller('api/platform/announcements')
@Auth('platform')
export class PlatformAnnouncementController {
  constructor(
    @Inject(PlatformAnnouncementService)
    private readonly announcements: PlatformAnnouncementService,
  ) {}

  @Get()
  @ApiOperation({ summary: '公告列表' })
  list(
    @Query(Validate(ListAnnouncementQueryDto)) query: ListAnnouncementQueryDto,
  ): Promise<PageResult<AnnouncementView>> {
    return this.announcements.list(query)
  }

  @Get(':id')
  @ApiOperation({ summary: '公告详情' })
  get(@Param('id') id: string): Promise<AnnouncementView> {
    return this.announcements.get(id)
  }

  @Get(':id/reads')
  @ApiOperation({ summary: '已读统计（总数 + 按读者身份分组）' })
  reads(@Param('id') id: string): Promise<AnnouncementReadStats> {
    return this.announcements.reads(id)
  }

  @Post()
  @ApiOperation({ summary: '新建公告（草稿）' })
  @Audit({ action: APP_AUDIT_ACTIONS.ANNOUNCEMENT_CREATE, targetType: 'Announcement' })
  create(
    @Body(Validate(CreateAnnouncementDto)) dto: CreateAnnouncementDto,
  ): Promise<AnnouncementView> {
    return this.announcements.create(dto)
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改公告' })
  @Audit({
    action: APP_AUDIT_ACTIONS.ANNOUNCEMENT_UPDATE,
    targetType: 'Announcement',
    targetId: targetIdFromParam,
  })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdateAnnouncementDto)) dto: UpdateAnnouncementDto,
  ): Promise<AnnouncementView> {
    return this.announcements.update(id, dto)
  }

  @Patch(':id/publish')
  @ApiOperation({ summary: '发布' })
  @Audit({
    action: AUDIT_ACTIONS.ANNOUNCEMENT_PUBLISH,
    targetType: 'Announcement',
    targetId: targetIdFromParam,
  })
  publish(@Param('id') id: string): Promise<AnnouncementView> {
    return this.announcements.publish(id)
  }

  @Patch(':id/unpublish')
  @ApiOperation({ summary: '下线（保留内容与已读回执）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.ANNOUNCEMENT_UNPUBLISH,
    targetType: 'Announcement',
    targetId: targetIdFromParam,
  })
  unpublish(@Param('id') id: string): Promise<AnnouncementView> {
    return this.announcements.unpublish(id)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除（仅限从未发布过的草稿）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.ANNOUNCEMENT_DELETE,
    targetType: 'Announcement',
    targetId: targetIdFromParam,
  })
  remove(@Param('id') id: string): Promise<{ id: string }> {
    return this.announcements.remove(id)
  }
}
