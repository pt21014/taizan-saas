/**
 * 内存版 `PlatformGateway`。
 *
 * 下游写「配额超了要拦住」这类业务单测时，不该为了一个闸门去起 Prisma 替身、
 * 更不该各造一个假的——三态语义（`null` 不限量 / `0` 一个都不给）复刻错了，
 * 测出来的绿是假的。这一份直接调 `@taizan/billing-rules`，与生产同源。
 *
 * @packageDocumentation
 */

import { checkQuota, resolveQuota, hasFeature, type QuotaCheckResult } from '@taizan/billing-rules'
import { ErrorCode } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import type {
  PlatformGateway,
  QuotaMutationResult,
  QuotaTx,
  TenantGateView,
} from '../platform-gateway'

/** 造一个「一切正常」的闸门视图，只覆盖你关心的字段。 */
export function tenantView(overrides: Partial<TenantGateView> = {}): TenantGateView {
  return {
    tenantId: 'TENANT0000000000000000001',
    slug: 'demo',
    name: '示例小店',
    status: 'ACTIVE',
    planExpireAt: new Date('2099-12-31T23:59:59.999Z'),
    trialEndAt: null,
    graceDays: 0,
    planId: 'PLAN00000000000000000001',
    planCode: 'basic',
    planName: '基础版',
    features: null,
    quotas: {},
    ...overrides,
  }
}

/** 内存版实现。 */
export class FakePlatformGateway implements PlatformGateway {
  private readonly tenants = new Map<string, TenantGateView>()
  private readonly counters = new Map<string, number>()

  /** 每个 tenantId 被真的「读库」了几次（缓存断言用）。 */
  readonly loads = new Map<string, number>()

  /** 放一家店进去。 */
  put(view: TenantGateView): void {
    this.tenants.set(view.tenantId, view)
  }

  /** 直接设已用量（造「已经用了 3 个」的初始状态）。 */
  setUsed(tenantId: string, kind: string, used: number): void {
    this.counters.set(`${tenantId}:${kind}`, used)
  }

  async getTenant(tenantId: string): Promise<TenantGateView | null> {
    this.loads.set(tenantId, (this.loads.get(tenantId) ?? 0) + 1)
    return this.tenants.get(tenantId) ?? null
  }

  async hasFeature(tenantId: string, key: string): Promise<boolean> {
    const view = await this.getTenant(tenantId)
    return view === null ? false : hasFeature(view.features, key)
  }

  async checkQuota(tenantId: string, kind: string, delta = 1): Promise<QuotaCheckResult> {
    return checkQuota(await this.limitOf(tenantId, kind), this.usedOf(tenantId, kind), delta)
  }

  async consumeQuota(
    tenantId: string,
    kind: string,
    delta = 1,
    _tx?: QuotaTx,
  ): Promise<QuotaMutationResult> {
    const limit = await this.limitOf(tenantId, kind)
    const used = this.usedOf(tenantId, kind)
    const verdict = checkQuota(limit, used, delta)
    if (!verdict.ok) {
      throw new BizException(ErrorCode.QUOTA_EXCEEDED, undefined, { kind, limit, used, delta })
    }
    this.counters.set(`${tenantId}:${kind}`, used + delta)
    return this.result(kind, limit, used + delta)
  }

  async releaseQuota(
    tenantId: string,
    kind: string,
    delta = 1,
    _tx?: QuotaTx,
  ): Promise<QuotaMutationResult> {
    const limit = await this.limitOf(tenantId, kind)
    const next = Math.max(0, this.usedOf(tenantId, kind) - delta)
    this.counters.set(`${tenantId}:${kind}`, next)
    return this.result(kind, limit, next)
  }

  invalidate(_tenantId: string): void {
    // 内存实现没有缓存，无事可做。方法留着是为了让替身与接口完全同形——
    // 少一个方法，下游把它塞进 `PlatformGateway` 类型的位置时才会报错，太晚了。
  }

  private usedOf(tenantId: string, kind: string): number {
    return this.counters.get(`${tenantId}:${kind}`) ?? 0
  }

  private async limitOf(tenantId: string, kind: string): Promise<number | null> {
    const view = this.tenants.get(tenantId)
    if (view === undefined) return null
    const overrides = view.tenantQuotaOverrides
    const hasOverride =
      overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, kind)
    return hasOverride
      ? resolveQuota(view.quotas, kind, overrides[kind] ?? null)
      : resolveQuota(view.quotas, kind)
  }

  private result(kind: string, limit: number | null, used: number): QuotaMutationResult {
    return { kind, limit, used, remaining: limit === null ? null : Math.max(0, limit - used) }
  }
}
