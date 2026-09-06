/**
 * 商家侧公告列表的 DTO。
 *
 * 只有查询，没有新建/修改——这一屏读的是**平台发给商家**的公告，商家是读者不是作者。
 *
 * @packageDocumentation
 */

import { ApiPropertyOptional } from '@nestjs/swagger'
import { Transform, Type } from 'class-transformer'
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator'

/** 平台公告列表查询。 */
export class ListAnnouncementQueryDto {
  @ApiPropertyOptional({ type: Number, description: '页码，从 1 开始', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须是整数' })
  @Min(1, { message: 'page 从 1 开始' })
  page?: number

  @ApiPropertyOptional({ type: Number, description: '每页条数，上限 200', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须是整数' })
  @Min(1, { message: 'pageSize 至少为 1' })
  @Max(200, { message: 'pageSize 上限 200' })
  pageSize?: number

  @ApiPropertyOptional({
    type: Boolean,
    description: '只看未读（顶栏那个小红点点开之后的列表）',
    default: false,
  })
  @IsOptional()
  // query string 里布尔值是 `'true'` / `'false'`，`@Type(() => Boolean)` 会把
  // 非空字符串一律转成 `true`（包括 `'false'`）——那是个很难发现的坑。
  @Transform(({ value }) => (typeof value === 'string' ? value === 'true' : value))
  @IsBoolean({ message: 'unreadOnly 必须是布尔值' })
  unreadOnly?: boolean
}
