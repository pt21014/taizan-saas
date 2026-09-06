/**
 * `/api/platform/jobs` —— 队列死信查看/重放 + cron 运行记录（T3-4 任务书条目②）。
 *
 * @packageDocumentation
 */

import { Controller, Get, Inject, Param, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Audit } from '@taizan/nest-audit'
import { Auth } from '@taizan/nest-auth'

import { Validate } from '../../../common/validate.pipe'
import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import { ListCronRunsQueryDto, ListDeadLettersQueryDto } from './dto/platform-job.dto'
import { PlatformJobService, type CronRunView, type DeadLetterView } from './platform-job.service'

@ApiTags('platform/jobs')
@Controller('api/platform/jobs')
@Auth('platform')
export class PlatformJobController {
  constructor(@Inject(PlatformJobService) private readonly jobs: PlatformJobService) {}

  @Get('dead-letters')
  @ApiOperation({ summary: '死信列表：分页 + 按 queue / resolved 筛' })
  listDeadLetters(
    @Query(Validate(ListDeadLettersQueryDto)) query: ListDeadLettersQueryDto,
  ): Promise<PageResult<DeadLetterView>> {
    return this.jobs.listDeadLetters(query)
  }

  @Post('dead-letters/:id/replay')
  @ApiOperation({ summary: '重放一条死信（原样重新入队），失败抛 1850000' })
  @Audit({
    action: APP_AUDIT_ACTIONS.JOB_DEAD_LETTER_REPLAY,
    targetType: 'JobDeadLetter',
    targetId: (req) => (typeof req.params.id === 'string' ? req.params.id : undefined),
  })
  replay(@Param('id') id: string): Promise<{ jobId: string }> {
    return this.jobs.replay(id)
  }

  @Get('cron-runs')
  @ApiOperation({ summary: 'cron 运行记录：最近的在前，核对 leader 锁是否正常' })
  listCronRuns(
    @Query(Validate(ListCronRunsQueryDto)) query: ListCronRunsQueryDto,
  ): Promise<PageResult<CronRunView>> {
    return this.jobs.listCronRuns(query)
  }
}
