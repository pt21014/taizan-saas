/**
 * `/api/platform/plans` —— 套餐 CRUD + 上下架 + 排序（T1-7）。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import { CreatePlanDto, ListPlanQueryDto, SortPlanDto, UpdatePlanDto } from './dto/plan.dto'
import { PlanService, type PlanView } from './plan.service'

function targetIdFromParam(req: { params: Record<string, unknown> }): string | undefined {
  return typeof req.params.id === 'string' ? req.params.id : undefined
}

@ApiTags('platform/plans')
@Controller('api/platform/plans')
@Auth('platform')
export class PlanController {
  constructor(@Inject(PlanService) private readonly plans: PlanService) {}

  @Get()
  @ApiOperation({ summary: '套餐列表' })
  list(@Query(Validate(ListPlanQueryDto)) query: ListPlanQueryDto): Promise<PageResult<PlanView>> {
    return this.plans.list(query)
  }

  @Get(':id')
  @ApiOperation({ summary: '套餐详情' })
  get(@Param('id') id: string): Promise<PlanView> {
    return this.plans.get(id)
  }

  @Post()
  @ApiOperation({ summary: '新建套餐' })
  @Audit({ action: APP_AUDIT_ACTIONS.PLAN_CREATE, targetType: 'Plan' })
  create(@Body(Validate(CreatePlanDto)) dto: CreatePlanDto): Promise<PlanView> {
    return this.plans.create(dto)
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改套餐（价格 / 配额 / 功能白名单）' })
  @Audit({ action: APP_AUDIT_ACTIONS.PLAN_UPDATE, targetType: 'Plan', targetId: targetIdFromParam })
  update(
    @Param('id') id: string,
    @Body(Validate(UpdatePlanDto)) dto: UpdatePlanDto,
  ): Promise<PlanView> {
    return this.plans.update(id, dto)
  }

  @Patch(':id/enable')
  @ApiOperation({ summary: '上架' })
  @Audit({
    action: APP_AUDIT_ACTIONS.PLAN_PUBLISH,
    targetType: 'Plan',
    targetId: targetIdFromParam,
  })
  enable(@Param('id') id: string): Promise<PlanView> {
    return this.plans.enable(id)
  }

  @Patch(':id/disable')
  @ApiOperation({ summary: '下架（存量租户不受影响）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.PLAN_UNPUBLISH,
    targetType: 'Plan',
    targetId: targetIdFromParam,
  })
  disable(@Param('id') id: string): Promise<PlanView> {
    return this.plans.disable(id)
  }

  @Patch(':id/archive')
  @ApiOperation({ summary: '归档（永不再售）' })
  @Audit({
    action: APP_AUDIT_ACTIONS.PLAN_ARCHIVE,
    targetType: 'Plan',
    targetId: targetIdFromParam,
  })
  archive(@Param('id') id: string): Promise<PlanView> {
    return this.plans.archive(id)
  }

  @Patch(':id/sort')
  @ApiOperation({ summary: '调整展示排序' })
  @Audit({ action: APP_AUDIT_ACTIONS.PLAN_SORT, targetType: 'Plan', targetId: targetIdFromParam })
  sort(@Param('id') id: string, @Body(Validate(SortPlanDto)) dto: SortPlanDto): Promise<PlanView> {
    return this.plans.sort(id, dto)
  }
}
