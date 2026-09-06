/**
 * `QuotaService`：业务代码扣配额的入口。
 *
 * ## 为什么不让调用方传 tenantId
 *
 * `PlatformGateway` 的方法都要显式 tenantId（它是平台侧接口，跨租户是它的本职）；
 * 而业务代码永远只操作**当前**租户。给业务留一个 tenantId 参数，就意味着总有一天
 * 有人从别处拿一个 id 传进来——而配额记错的表现是「商家莫名其妙被拦住」或者
 * 「限额形同虚设」，两种都不报错，也没人会发现。所以这里从上下文取，取不到直接抛。
 *
 * knowledge 的 `TenantBillingService` 在这一点上是对的（`currentTenantId()` 私有），
 * 唯一的差别是它取不到时**静默 return**——那等于「没有租户上下文 = 不限量」，
 * 在队列 job 里就是配额彻底失效。这里改成抛错。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { QuotaCheckResult } from '@taizan/billing-rules'
import { requireTenantId } from '@taizan/nest-core'
import type { PlatformGateway, QuotaMutationResult, QuotaTx } from './platform-gateway'
import { PLATFORM_GATEWAY } from './tokens'

/** 一个配额维度的当前状况，给后台顶栏 / 账单页用。 */
export interface QuotaUsage {
  kind: string
  /** `null` = 不限量。 */
  limit: number | null
  used: number
  /** `null` = 不限量。 */
  remaining: number | null
}

@Injectable()
export class QuotaService {
  constructor(@Inject(PLATFORM_GATEWAY) private readonly gateway: PlatformGateway) {}

  /**
   * 占用配额。超限抛 `1540301`。
   *
   * **在写业务数据之前调**，并且尽量把 `tx` 传进来（同一个事务里扣 + 建），
   * 否则业务写失败时计数已经加上去了，而虚高的计数没有人会去修。
   *
   * @param kind - `QuotaKind` 枚举值，例如 `'STAFF'`
   * @param delta - 这次要占几个，默认 1
   * @param tx - 事务句柄，来自 `prisma.$transaction((tx) => …)`
   */
  async consume(kind: string, delta = 1, tx?: QuotaTx): Promise<QuotaMutationResult> {
    return this.gateway.consumeQuota(requireTenantId(), kind, delta, tx)
  }

  /** 释放配额（删员工、撤单、上传失败回滚）。不会减到负数。 */
  async release(kind: string, delta = 1, tx?: QuotaTx): Promise<QuotaMutationResult> {
    return this.gateway.releaseQuota(requireTenantId(), kind, delta, tx)
  }

  /** 只算不写：再要 `delta` 个够不够。给「新建按钮要不要置灰」这类前置判断用。 */
  async check(kind: string, delta = 1): Promise<QuotaCheckResult> {
    return this.gateway.checkQuota(requireTenantId(), kind, delta)
  }

  /** 当前用量快照（`delta=0` 的一次 check，不写库）。 */
  async usage(kind: string): Promise<QuotaUsage> {
    const r = await this.gateway.checkQuota(requireTenantId(), kind, 0)
    return { kind, limit: r.limit, used: r.used, remaining: r.remaining }
  }
}
