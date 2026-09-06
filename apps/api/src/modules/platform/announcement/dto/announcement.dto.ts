import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

/** `Announcement.audience` 全集，与 `06-ops.prisma` 的 `Audience` 一一对应。 */
export const ANNOUNCEMENT_AUDIENCES = ['ALL_TENANT', 'PLAN', 'TENANT_IDS', 'C_END'] as const

/** `Announcement.level` 全集，与 `06-ops.prisma` 的 `AnnouncementLevel` 一一对应。 */
export const ANNOUNCEMENT_LEVELS = ['INFO', 'WARNING', 'CRITICAL'] as const

/** `Announcement.status` 全集，与 `06-ops.prisma` 的 `AnnouncementStatus` 一一对应。 */
export const ANNOUNCEMENT_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const

/** 新建公告（落 `DRAFT`）。 */
export class CreateAnnouncementDto {
  @ApiProperty({ type: String })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string

  @ApiProperty({ type: String, description: '公告正文（HTML）' })
  @IsString()
  @MinLength(1)
  contentHtml!: string

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_AUDIENCES, default: 'ALL_TENANT' })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_AUDIENCES as readonly string[])
  audience?: (typeof ANNOUNCEMENT_AUDIENCES)[number]

  @ApiPropertyOptional({
    type: [String],
    description: 'audience=PLAN 时是 Plan.code 数组；TENANT_IDS 时是 Tenant.id 数组',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audienceRefs?: string[]

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_LEVELS, default: 'INFO' })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_LEVELS as readonly string[])
  level?: (typeof ANNOUNCEMENT_LEVELS)[number]

  @ApiProperty({ type: String, description: '计划展示起始时间，ISO 字符串' })
  @IsDateString()
  publishAt!: string

  @ApiPropertyOptional({
    type: String,
    description: '过期时间，ISO 字符串，不传就一直展示到手动下线',
  })
  @IsOptional()
  @IsDateString()
  expireAt?: string
}

/** 修改公告。 */
export class UpdateAnnouncementDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MinLength(1)
  contentHtml?: string

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_AUDIENCES })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_AUDIENCES as readonly string[])
  audience?: (typeof ANNOUNCEMENT_AUDIENCES)[number]

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audienceRefs?: string[]

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_LEVELS })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_LEVELS as readonly string[])
  level?: (typeof ANNOUNCEMENT_LEVELS)[number]

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsDateString()
  publishAt?: string

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsDateString()
  expireAt?: string
}

/** 公告列表查询。 */
export class ListAnnouncementQueryDto {
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

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_STATUSES })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_STATUSES as readonly string[])
  status?: (typeof ANNOUNCEMENT_STATUSES)[number]

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_AUDIENCES })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_AUDIENCES as readonly string[])
  audience?: (typeof ANNOUNCEMENT_AUDIENCES)[number]
}
