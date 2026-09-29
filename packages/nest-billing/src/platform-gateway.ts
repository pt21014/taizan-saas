/**
 * `PlatformGateway`：业务侧问「这家店能不能干这件事」的**唯一入口**。
 *
 * 接口形状以三个读方法为核心（`getTenant` / `hasFeature` / `checkQuota`），
 * 本包按实际用法补了 `consumeQuota` / `releaseQuota` / `invalidate`。
 * 之所以要有这么一层接口而不是让守卫直接查库：将来平台侧若从「同库同进程」平移成
 * 独立的控制面服务（租户、套餐、配额由单独的平台服务托管，业务服务经 RPC/HTTP 查询），
 * 需要替换的就只有这一个实现类，守卫与业务代码都不用动。
 *
 * ## 本文件不做任何判定
 *
 * 「到期没到期」「配额够不够」「买没买这个功能」三个问题的答案全部来自
 * `@taizan/billing-rules` 的纯函数。这里只负责：**把库里的行拼成规则函数要的入参**、
 * **缓存**、**把计数落回 `QuotaCounter`**。
 * 想改判定口径请去 `@taizan/billing-rules`，改这里等于让规则出现第二份实现。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, Optional } from '@nestjs/common'
import {
  checkQuota,
  resolveQuota,
  hasFeature,
  type PlanQuotas,
  type QuotaCheckResult,
  type TenantStatusLike,
} from '@taizan/billing-rules'
import { ErrorCode, ulid } from '@taizan/contracts'
import { AppLogger, BizException } from '@taizan/nest-core'
import { systemClock, type Clock } from '@taizan/nest-auth'
import {
  isOptimisticLockError,
  updateWithVersion,
  PrismaService,
  type PrismaClientLike,
} from '@taizan/nest-prisma'
import { BILLING_CLOCK, GATEWAY_OPTIONS } from './tokens'

/**
 * 闸门要看的那点租户信息。
 *
 * 刻意**不是** `Tenant` 行的全貌：闸门只需要这几个字段，多带一个字段就多一个
 * 「顺手在守卫里读一下」的机会，而守卫是每个写请求都跑的地方。
 */
export interface TenantGateView {
  tenantId: string
  slug: string
  name: string
  /** `TenantStatus`，刻意没有 `EXPIRED`——到期永远现算。 */
  status: TenantStatusLike
  planExpireAt: Date | null
  trialEndAt: Date | null
  graceDays: number
  /** 套餐 id / code / name，给「去续费」提示用；无套餐时全为 null。 */
  planId: string | null
  planCode: string | null
  planName: string | null
  /** 三态：`null` 全部功能可用，`[]` 一个都没有。 */
  features: string[] | null
  /** 三态：缺省或 `null` 不限量，`0` 一个都不给。 */
  quotas: PlanQuotas
  /**
   * 租户级配额覆盖（平台给某家店单独放宽/收紧时用）。
   *
   * 命中的 key 优先于套餐值，包括显式的 `null`（把某一项改成不限量）。
   * 当前 `01-tenant.prisma` 里还没有这一列，所以默认恒为 `undefined`；
   * 下游项目可以自己实现 `PlatformGateway` 或传 `loadOverrides` 把它填上。
   */
  tenantQuotaOverrides?: PlanQuotas
}

/** {@link PlatformGateway.consumeQuota} / `releaseQuota` 的结果。 */
export interface QuotaMutationResult {
  kind: string
  /** 生效上限（已应用租户覆盖）。`null` = 不限量。 */
  limit: number | null
  /** 变更后的已用量。 */
  used: number
  /** 剩余量；不限量时为 `null`。 */
  remaining: number | null
}

/**
 * 事务句柄。`consumeQuota` 允许调用方把自己的事务传进来，
 * 让「建一条员工 + 计数 +1」落在同一个事务里——否则中途失败就会计数虚高，
 * 而虚高的计数没有任何人会去修，最终表现为「明明只有 2 个员工却说超了 3 个」。
 */
export type QuotaTx = PrismaClientLike

/** 权益判定的统一入口。业务代码只跟这个接口打交道。 */
export interface PlatformGateway {
  /** 取闸门视图；租户不存在返回 `null`（**不抛**，让调用方决定怎么报）。 */
  getTenant(tenantId: string): Promise<TenantGateView | null>
  /** 这家店买没买 `key` 这个功能。租户不存在时按「没买」处理。 */
  hasFeature(tenantId: string, key: string): Promise<boolean>
  /** 只算不写：现在再要 `delta` 个够不够。 */
  checkQuota(tenantId: string, kind: string, delta?: number): Promise<QuotaCheckResult>
  /** 占用配额；不够时抛 `1540301`。 */
  consumeQuota(
    tenantId: string,
    kind: string,
    delta?: number,
    tx?: QuotaTx,
  ): Promise<QuotaMutationResult>
  /** 释放配额（删员工、撤单）。不会减到负数。 */
  releaseQuota(
    tenantId: string,
    kind: string,
    delta?: number,
    tx?: QuotaTx,
  ): Promise<QuotaMutationResult>
  /** 清掉这家店的缓存。续费 / 改套餐 / 冻结解冻之后**必须**调。 */
  invalidate(tenantId: string): void
}

/** 闸门视图的缓存有效期。 */
export const GATE_CACHE_TTL_MS = 30_000

/** 乐观锁冲突的重试次数上限。 */
export const QUOTA_MAX_RETRY = 5

interface CacheEntry {
  at: number
  view: TenantGateView | null
}

interface TenantRow {
  id: string
  slug: string
  name: string
  status: string
  planId: string | null
  planExpireAt: Date | null
  trialEndAt: Date | null
  graceDays: number
}

interface PlanRow {
  id: string
  code: string
  name: string
  quotas: unknown
  features: unknown
}

interface CounterRow {
  id: string
  used: number
  version: number
}

/**
 * `Plan.features` 是 Json 列，库里可能是 `null`、数组、也可能是被谁写坏的对象。
 *
 * 形状坏了一律当 **`null`（全部可用）**，而不是 `[]`（一个都没有）——
 * 坏数据的代价必须落在平台身上（少收点钱），不能落在商家身上
 * （整个后台突然全变灰，而商家什么都没做）。
 */
export function normalizeFeatures(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const keys = raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
  // 数组里一个合法 key 都没有时仍然回 `[]` 而不是 `null`：
  // 「显式给了空数组」是平台的真实意图（一个功能都不含的白牌套餐），得保留。
  return keys
}

/**
 * `Plan.quotas` 同上。三态要保住：缺省 / `null` 都是不限量，`0` 是一个都不给。
 *
 * 非数字、负数、小数一律丢弃（当成缺省 = 不限量）；`resolveQuota` 那边会对
 * 留下来的值再做一次非负整数断言，两道都过不了的值不会变成「悄悄限成 0」。
 */
export function normalizeQuotas(raw: unknown): PlanQuotas {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PlanQuotas = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) {
      out[key] = null
    } else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      out[key] = value
    }
  }
  return out
}

function isTenantStatus(value: string): value is TenantStatusLike {
  return (
    value === 'TRIAL' || value === 'ACTIVE' || value === 'SUSPENDED' || value === 'DEREGISTERED'
  )
}

/** {@link PrismaPlatformGateway} 的可选装配项。 */
export interface PlatformGatewayOptions {
  /** 缓存有效期（毫秒），默认 {@link GATE_CACHE_TTL_MS}。 */
  cacheTtlMs?: number
  /** 租户级配额覆盖的加载器。不传就没有覆盖。 */
  loadOverrides?: (tenantId: string) => Promise<PlanQuotas | undefined>
}

/**
 * 查库版实现。
 *
 * ## 为什么走 `prisma.raw`
 *
 * 闸门在守卫与中间件里跑，那时租户上下文要么刚写进去、要么还没写（C 端中间件在
 * 租户解析之后但业务之前）。更根本的是：`Tenant` 是**平台域**的表，用租户句柄读它
 * 语义上就不对。每个用点都写了 `// raw-reason:`，由 spec 3 看住。
 *
 * ## 为什么缓存是进程内 Map
 *
 * 见 {@link PrismaPlatformGateway.cache} 上的注释。
 */
@Injectable()
export class PrismaPlatformGateway implements PlatformGateway {
  /**
   * process-local: 闸门视图缓存。每个写请求都要读一次租户，走 Redis 等于给每个写请求
   * 加一次网络往返；而这份数据是「几乎不变、变了晚 30 秒生效也只是少收 30 秒钱」的那种。
   * 多实例之间不同步，靠 30 秒 TTL 自然收敛；真的要秒级生效（续费、解冻）由平台侧
   * 显式调 {@link PrismaPlatformGateway.invalidate}。
   *
   * TODO(T2-1 接线后)：`CacheService` 可用时改成「本地 Map + Redis pub/sub 失效广播」，
   * 让 invalidate 能跨实例。在那之前多实例下 invalidate 只清本实例。
   */
  private readonly cache = new Map<string, CacheEntry>()

  private readonly ttlMs: number
  private readonly loadOverrides: PlatformGatewayOptions['loadOverrides']

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(BILLING_CLOCK) private readonly clock: Clock = systemClock,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
    // 全部走注入 token（而不是一个裸的第 4 个构造参数）：
    // 裸参数在 Nest 的 DI 里解析不到，把这个类直接写进 providers 就会启动失败，
    // 而那正是下游最可能顺手做的事。
    @Optional() @Inject(GATEWAY_OPTIONS) options: PlatformGatewayOptions | undefined = undefined,
  ) {
    this.ttlMs = options?.cacheTtlMs ?? GATE_CACHE_TTL_MS
    this.loadOverrides = options?.loadOverrides
  }

  async getTenant(tenantId: string): Promise<TenantGateView | null> {
    const hit = this.cache.get(tenantId)
    if (hit !== undefined && this.clock.now() - hit.at < this.ttlMs) return hit.view

    const view = await this.load(tenantId)
    this.cache.set(tenantId, { at: this.clock.now(), view })
    return view
  }

  /**
   * 缓存清除。**续费、改套餐、冻结、解冻、注销之后必须调**——
   * 否则商家付完钱最多还要再等 30 秒才解锁，而那 30 秒里他会以为没付成功，然后再付一次。
   */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId)
  }

  async hasFeature(tenantId: string, key: string): Promise<boolean> {
    const view = await this.getTenant(tenantId)
    // 租户读不到时按「没买」处理：读不到租户本来就该在别处报错，
    // 这里放行等于给一个不存在的租户开全部功能。
    if (view === null) return false
    return hasFeature(view.features, key)
  }

  async checkQuota(tenantId: string, kind: string, delta = 1): Promise<QuotaCheckResult> {
    const limit = await this.limitOf(tenantId, kind)
    const used = await this.usedOf(this.prisma.raw as PrismaClientLike, tenantId, kind)
    return checkQuota(limit, used, delta)
  }

  async consumeQuota(
    tenantId: string,
    kind: string,
    delta = 1,
    tx?: QuotaTx,
  ): Promise<QuotaMutationResult> {
    return this.mutate(tenantId, kind, delta, tx, 'consume')
  }

  async releaseQuota(
    tenantId: string,
    kind: string,
    delta = 1,
    tx?: QuotaTx,
  ): Promise<QuotaMutationResult> {
    return this.mutate(tenantId, kind, delta, tx, 'release')
  }

  /** 生效上限：租户覆盖优先于套餐值，两者都没有就是不限量。 */
  private async limitOf(tenantId: string, kind: string): Promise<number | null> {
    const view = await this.getTenant(tenantId)
    if (view === null) return null
    const overrides = view.tenantQuotaOverrides
    // `hasOwnProperty` 而不是 `?? undefined`：租户覆盖里显式写的 `null`（改成不限量）
    // 和「这一项没有覆盖」是两件事，用 `??` 会把前者当成后者。
    const hasOverride =
      overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, kind)
    return hasOverride
      ? resolveQuota(view.quotas, kind, overrides[kind] ?? null)
      : resolveQuota(view.quotas, kind)
  }

  private async load(tenantId: string): Promise<TenantGateView | null> {
    // raw-reason: 闸门需在租户上下文建立前读租户状态；Tenant 本身是平台域的表。
    const raw = this.prisma.raw as PrismaClientLike
    const tenant = (await callModel(raw, 'tenant', 'findUnique', {
      where: { id: tenantId },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        planId: true,
        planExpireAt: true,
        trialEndAt: true,
        graceDays: true,
      },
    })) as TenantRow | null
    if (tenant === null) return null

    let plan: PlanRow | null = null
    if (tenant.planId !== null && tenant.planId !== '') {
      // raw-reason: Plan 是平台域的表（全平台共享一份），租户句柄读不到它。
      plan = (await callModel(raw, 'plan', 'findUnique', {
        where: { id: tenant.planId },
        select: { id: true, code: true, name: true, quotas: true, features: true },
      })) as PlanRow | null
    }

    if (!isTenantStatus(tenant.status)) {
      // 状态是库里的 enum，出现认不得的值说明 schema 与代码不同版本了。
      // 这种时候按最保守的「冻结」处理会锁住所有商家，按最宽松处理又等于闸门失效——
      // 抛错让它在部署时就炸，比两者都好。
      throw new TypeError(
        `[@taizan/nest-billing] 认不出的租户状态 ${JSON.stringify(tenant.status)}（tenantId=${tenantId}），schema 与代码版本不一致`,
      )
    }

    const view: TenantGateView = {
      tenantId: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      planExpireAt: tenant.planExpireAt,
      trialEndAt: tenant.trialEndAt,
      graceDays: tenant.graceDays,
      planId: plan?.id ?? null,
      planCode: plan?.code ?? null,
      planName: plan?.name ?? null,
      features: plan === null ? null : normalizeFeatures(plan.features),
      quotas: plan === null ? {} : normalizeQuotas(plan.quotas),
    }

    const overrides = await this.loadOverrides?.(tenantId)
    if (overrides !== undefined) view.tenantQuotaOverrides = overrides

    return view
  }

  private async usedOf(client: PrismaClientLike, tenantId: string, kind: string): Promise<number> {
    const row = await this.counterOf(client, tenantId, kind)
    return row?.used ?? 0
  }

  private async counterOf(
    client: PrismaClientLike,
    tenantId: string,
    kind: string,
  ): Promise<CounterRow | null> {
    // raw-reason: 配额计数按显式 tenantId 记账——调用方可能是平台侧（开通/续费/纠偏），
    // 那时没有租户上下文；传进来的 tx 若是租户句柄，租户条件会被扩展再包一层，不冲突。
    return (await callModel(client, 'quotaCounter', 'findFirst', {
      where: { tenantId, kind },
      select: { id: true, used: true, version: true },
    })) as CounterRow | null
  }

  /**
   * 扣减 / 释放的公共实现：**读 → 判 → 带版本号写 → 冲突就重来**。
   *
   * 为什么不用 `used: { increment: delta }` 一条 SQL 搞定：那样写不出「超了就拒」——
   * 数据库层没有 `CHECK used <= limit`（limit 在另一张表且三态），
   * 一条 increment 会先把计数写超再由应用发现，那时已经晚了。
   */
  private async mutate(
    tenantId: string,
    kind: string,
    delta: number,
    tx: QuotaTx | undefined,
    mode: 'consume' | 'release',
  ): Promise<QuotaMutationResult> {
    if (!Number.isInteger(delta) || delta < 0) {
      throw new TypeError(
        `[@taizan/nest-billing] 配额增减量必须是非负整数，收到 ${String(delta)}（想减就用 releaseQuota）`,
      )
    }
    const limit = await this.limitOf(tenantId, kind)
    const client = tx ?? (this.prisma.raw as PrismaClientLike)

    let lastError: unknown = null
    for (let attempt = 0; attempt <= QUOTA_MAX_RETRY; attempt++) {
      const counter = await this.counterOf(client, tenantId, kind)
      const used = counter?.used ?? 0

      if (mode === 'consume') {
        const verdict = checkQuota(limit, used, delta)
        if (!verdict.ok) {
          throw new BizException(
            ErrorCode.QUOTA_EXCEEDED,
            `${quotaLabel(kind)}已达套餐上限（${used}/${String(verdict.limit)}），请升级套餐或先清理`,
            { kind, limit: verdict.limit, used, delta },
          )
        }
      }

      const next =
        mode === 'consume'
          ? used + delta
          : // 减不到负数：释放比占用多跑一次（重试、重放、手工纠偏）是常态，
            // 让计数变成 -1 会让下一次「够不够」判成永远够。
            Math.max(0, used - delta)

      if (counter === null) {
        if (next === 0) return result(kind, limit, 0)
        try {
          await callModel(client, 'quotaCounter', 'create', {
            data: { id: ulid(), tenantId, kind, used: next, version: 0 },
          })
          return result(kind, limit, next)
        } catch (error) {
          // 唯一键 `[tenantId, kind]` 冲突：别的请求刚建了同一行，重来一遍走 update 分支。
          lastError = error
          continue
        }
      }

      try {
        await updateWithVersion(client, 'QuotaCounter', {
          where: { id: counter.id },
          expectedVersion: counter.version,
          data: { used: next },
        })
        return result(kind, limit, next)
      } catch (error) {
        if (!isOptimisticLockError(error)) throw error
        lastError = error
      }
    }

    this.logger?.error(
      `配额计数并发冲突超过 ${String(QUOTA_MAX_RETRY)} 次仍未成功：tenant=${tenantId} kind=${kind}`,
      undefined,
      'BillingQuota',
    )
    throw lastError instanceof Error
      ? lastError
      : new Error(`[@taizan/nest-billing] 配额计数写入失败：${tenantId}/${kind}`)
  }
}

function result(kind: string, limit: number | null, used: number): QuotaMutationResult {
  return { kind, limit, used, remaining: limit === null ? null : Math.max(0, limit - used) }
}

/** 中文量词，只为把错误提示写得像人话；认不出的 kind 原样回显。 */
function quotaLabel(kind: string): string {
  const table: Record<string, string> = {
    STAFF: '员工数',
    STORE: '门店数',
    MEMBER: '会员数',
    STORAGE_MB: '存储空间',
    TRAFFIC_MB: '月流量',
  }
  return table[kind] ?? kind
}

/**
 * 调一次 `client.<model>.<operation>(args)`。
 *
 * 不用 `@taizan/nest-prisma` 的 `callOperation` 是因为它要的是 Prisma 模型名再转 key，
 * 这里几处调用点的 key 是写死的字面量，多绕一层反而看不出在查哪张表。
 */
async function callModel(
  client: PrismaClientLike,
  clientKey: string,
  operation: string,
  args: unknown,
): Promise<unknown> {
  const delegate = (client as unknown as Record<string, Record<string, unknown>>)[clientKey]
  const fn = delegate?.[operation]
  if (typeof fn !== 'function') {
    throw new TypeError(
      `[@taizan/nest-billing] Prisma 客户端上没有 ${clientKey}.${operation}——schema 里缺这张表？`,
    )
  }
  return (fn as (a: unknown) => Promise<unknown>).call(delegate, args)
}
