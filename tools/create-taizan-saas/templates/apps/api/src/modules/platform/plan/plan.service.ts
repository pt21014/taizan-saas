/**
 * 套餐 CRUD + 上下架 + 排序（T1-7）。
 *
 * `Plan` 是平台域表（全平台共享一份，没有 `tenantId` 列），本文件全程走
 * `RawPrismaService`——属于 `raw-reasons.ts` 里 `src/modules/platform/` 整目录的豁免。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode, normalizePage, ulid, type PageResult } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import { Prisma } from '@prisma/client'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type { CreatePlanDto, ListPlanQueryDto, SortPlanDto, UpdatePlanDto } from './dto/plan.dto'
import {
  normalizePlanCode,
  validateFeatures,
  validatePlanCoreInput,
  validatePlanCorePatch,
  validateQuotas,
  type RuleViolation,
} from './plan.rules'

/** 下发给平台后台的套餐行。 */
export interface PlanView {
  id: string
  code: string
  name: string
  firstPriceCents: number
  renewPriceCents: number
  periodMonths: number
  quotas: Record<string, number | null>
  /** `null` = 全部可用。 */
  features: string[] | null
  appKeys: string[]
  trafficMb: number
  status: string
  sort: number
  createdAt: string
  updatedAt: string
}

type PlanRow = NonNullable<Awaited<ReturnType<AppPrismaClient['plan']['findUnique']>>>

function toView(row: PlanRow): PlanView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    firstPriceCents: row.firstPriceCents,
    renewPriceCents: row.renewPriceCents,
    periodMonths: row.periodMonths,
    quotas: row.quotas as Record<string, number | null>,
    features: (row.features as string[] | null) ?? null,
    appKeys: row.appKeys as string[],
    trafficMb: row.trafficMb,
    status: row.status,
    sort: row.sort,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * `Plan.features` 是 `Json?`：Prisma 要求「显式设为 NULL」用 `Prisma.JsonNull` 这个哨兵值，
 * 裸 `null` 在类型上会被当成「不知道该写什么」而拒绝——这与 `undefined`（不写这一列）
 * 是三个不同的东西，Prisma 的类型系统把它们全部区分开了。
 */
function toFeaturesJson(features: string[] | null): string[] | typeof Prisma.JsonNull {
  return features === null ? Prisma.JsonNull : features
}

function rejectViolations(violations: readonly RuleViolation[]): void {
  if (violations.length === 0) return
  throw new BizException(ErrorCode.BAD_REQUEST, violations.map((v) => v.message).join('；'), {
    violations,
  })
}

@Injectable()
export class PlanService {
  constructor(
    // raw-reason: 平台后台——Plan 是平台域表，全平台共享一份，没有 tenantId 列。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
  ) {}

  async list(query: ListPlanQueryDto): Promise<PageResult<PlanView>> {
    const { page, pageSize } = normalizePage(query)
    const where = query.status ? { status: query.status } : {}

    // raw-reason: 平台后台——套餐列表，Plan 是平台域表。
    const [rows, total] = await Promise.all([
      this.raw.client.plan.findMany({
        where,
        orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.raw.client.plan.count({ where }),
    ])
    return { items: rows.map(toView), total, page, pageSize }
  }

  async get(id: string): Promise<PlanView> {
    return toView(await this.requirePlan(id))
  }

  /** @throws `BizException` 1040000 校验不通过，或 code 已被占用 */
  async create(dto: CreatePlanDto): Promise<PlanView> {
    rejectViolations(validatePlanCoreInput(dto))
    rejectViolations(validateQuotas(dto.quotas))
    rejectViolations(validateFeatures(dto.features))

    const code = normalizePlanCode(dto.code)
    // raw-reason: 平台后台——套餐 code 全局唯一性检查，Plan 是平台域表。
    const taken = await this.raw.client.plan.findUnique({ where: { code } })
    if (taken) throw new BizException(ErrorCode.BAD_REQUEST, `套餐 code「${code}」已经被占用了`)

    // raw-reason: 平台后台——新建套餐，Plan 是平台域表。
    const row = await this.raw.client.plan.create({
      data: {
        id: ulid(),
        code,
        name: dto.name.trim(),
        firstPriceCents: dto.firstPriceCents,
        renewPriceCents: dto.renewPriceCents,
        periodMonths: dto.periodMonths,
        quotas: dto.quotas,
        // `dto.features` 未传时是 `undefined`；Prisma 的 Json? 列把 `undefined` 当「不写这一列」，
        // 落到新建行上就是列默认值——`Plan.features` 没有 `@default`，会是 `NULL`，
        // 正好是我们想要的「全部可用」。这里显式 `?? null` 只是让这份意图不必读 schema 才看得懂。
        features: toFeaturesJson(dto.features ?? null),
        appKeys: dto.appKeys,
        trafficMb: dto.trafficMb ?? 0,
        status: 'ENABLED',
        sort: dto.sort ?? 0,
      },
    })
    return toView(row)
  }

  /** @throws `BizException` 1040000 校验不通过，或改的 code 与别的套餐冲突 */
  async update(id: string, dto: UpdatePlanDto): Promise<PlanView> {
    const current = await this.requirePlan(id)
    rejectViolations(validatePlanCorePatch(dto))
    rejectViolations(validateQuotas(dto.quotas))
    rejectViolations(validateFeatures(dto.features))

    let code: string | undefined
    if (dto.code !== undefined) {
      code = normalizePlanCode(dto.code)
      if (code !== current.code) {
        // raw-reason: 平台后台——改 code 前查一下有没有撞车，Plan 是平台域表。
        const taken = await this.raw.client.plan.findUnique({ where: { code } })
        if (taken) throw new BizException(ErrorCode.BAD_REQUEST, `套餐 code「${code}」已经被占用了`)
      }
    }

    // quotas 按 key 合并：patch 里没提到的维度保持原值，提到的（含显式 null）整体覆盖。
    const quotas =
      dto.quotas !== undefined
        ? { ...(current.quotas as Record<string, number | null>), ...dto.quotas }
        : undefined

    // raw-reason: 平台后台——修改套餐，Plan 是平台域表。
    const row = await this.raw.client.plan.update({
      where: { id },
      data: {
        ...(code !== undefined ? { code } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.firstPriceCents !== undefined ? { firstPriceCents: dto.firstPriceCents } : {}),
        ...(dto.renewPriceCents !== undefined ? { renewPriceCents: dto.renewPriceCents } : {}),
        ...(dto.periodMonths !== undefined ? { periodMonths: dto.periodMonths } : {}),
        ...(quotas !== undefined ? { quotas } : {}),
        // `'features' in dto`：区分「这次 patch 没提 features」与「显式传了 null」——
        // 后者要落库覆盖成 NULL，前者一个字段都不该出现在 `data` 里。
        ...('features' in dto ? { features: toFeaturesJson(dto.features ?? null) } : {}),
        ...(dto.appKeys !== undefined ? { appKeys: dto.appKeys } : {}),
        ...(dto.trafficMb !== undefined ? { trafficMb: dto.trafficMb } : {}),
      },
    })
    return toView(row)
  }

  /** 上架。 */
  async enable(id: string): Promise<PlanView> {
    await this.requirePlan(id)
    // raw-reason: 平台后台——套餐上架，Plan 是平台域表。
    return toView(await this.raw.client.plan.update({ where: { id }, data: { status: 'ENABLED' } }))
  }

  /** 下架：暂时不再售卖，存量租户不受影响（只是新开通/续费选不到它）。 */
  async disable(id: string): Promise<PlanView> {
    await this.requirePlan(id)
    // raw-reason: 平台后台——套餐下架，Plan 是平台域表。
    return toView(
      await this.raw.client.plan.update({ where: { id }, data: { status: 'DISABLED' } }),
    )
  }

  /** 归档：永不再售，只为存量租户与历史订单保留。 */
  async archive(id: string): Promise<PlanView> {
    await this.requirePlan(id)
    // raw-reason: 平台后台——套餐归档，Plan 是平台域表。
    return toView(
      await this.raw.client.plan.update({ where: { id }, data: { status: 'ARCHIVED' } }),
    )
  }

  async sort(id: string, dto: SortPlanDto): Promise<PlanView> {
    await this.requirePlan(id)
    // raw-reason: 平台后台——调整展示排序，Plan 是平台域表。
    return toView(await this.raw.client.plan.update({ where: { id }, data: { sort: dto.sort } }))
  }

  private async requirePlan(id: string): Promise<PlanRow> {
    // raw-reason: 平台后台——按 id 取套餐，Plan 是平台域表。
    const row = await this.raw.client.plan.findUnique({ where: { id } })
    if (!row) throw new BizException(ErrorCode.BAD_REQUEST, '套餐不存在')
    return row
  }
}
