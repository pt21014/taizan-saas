import { ApiPropertyOptional } from '@nestjs/swagger'
import { Transform, Type } from 'class-transformer'
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

/** 死信状态过滤：`true` = 只看已重放，`false` = 只看待处理，不传 = 都看。 */
export class ListDeadLettersQueryDto {
  @ApiPropertyOptional({ type: Number, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ type: Number, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number

  @ApiPropertyOptional({ type: String, description: '按队列名精确筛选' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  queue?: string

  @ApiPropertyOptional({
    type: Boolean,
    description: 'true = 只看已重放（resolvedAt 非空），false = 只看待处理，不传 = 都看',
  })
  @IsOptional()
  // query string 里布尔值是 `'true'` / `'false'`，`@Type(() => Boolean)` 会把非空字符串
  // 一律转成 `true`（包括 `'false'`）——那是个很难发现的坑，照抄
  // `announcement.dto.ts` 的 `unreadOnly` 那条写法。
  @Transform(({ value }) => (typeof value === 'string' ? value === 'true' : value))
  @IsBoolean({ message: 'resolved 必须是布尔值' })
  resolved?: boolean
}

/** cron 运行记录列表查询。 */
export class ListCronRunsQueryDto {
  @ApiPropertyOptional({ type: Number, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ type: Number, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number

  @ApiPropertyOptional({ type: String, description: '按任务 key（同 @LeaderCron 的 key）精确筛选' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  key?: string

  @ApiPropertyOptional({
    enum: ['ok', 'failed'],
    description: 'ok = 只看成功，failed = 只看失败，不传 = 都看',
  })
  @IsOptional()
  @IsIn(['ok', 'failed'])
  outcome?: 'ok' | 'failed'
}
