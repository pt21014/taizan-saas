/**
 * 成员关系查询：「这个账号在这家店里是谁、还在不在、什么角色」。
 *
 * 这是蓝图 §4.3 那条关键不变量的落点：**staff 每请求现查成员关系，并用库里的角色
 * 覆盖 token 里的**。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { RawPrismaService } from '@taizan/nest-prisma'
import type { Clock } from '../clock'
import type { DataScope, StaffStatus } from '../principal'

/** 一条成员关系（`Staff` 行的认证相关切片）。 */
export interface Membership {
  /** `Staff.id`，也是 staff token 的 `sub`。 */
  staffId: string
  status: StaffStatus
  roleIds: string[]
  dataScope: DataScope
  isOwner: boolean
}

/**
 * 成员关系提供者。
 *
 * 抽成接口是为了让下游能换实现——比如把成员关系放到独立的鉴权服务里，
 * 或者在测试里塞一个不连库的假实现。`AuthModule.forRoot({ membershipProvider })` 可覆盖。
 */
export interface MembershipProvider {
  /**
   * 查一条成员关系。
   *
   * @param accountId - `StaffAccount.id`
   * @param tenantId - 目标店铺
   * @returns 成员关系；不存在（从没加入 / 已软删）返回 `null`
   */
  membershipById(accountId: string, tenantId: string): Promise<Membership | null>

  /**
   * 让某条成员关系的缓存立即失效。
   *
   * 改角色、停用、移出店铺之后调它，把 30 秒的撤权延迟压到本实例内的 0 秒。
   * 注意它**只对当前进程有效**，多实例部署下别的实例仍要等缓存自然过期——
   * 这是刻意接受的取舍，见 {@link CachedMembershipProvider}。
   */
  invalidate(accountId: string, tenantId: string): void
}

/** Prisma 里 `Staff` 行的最小形状（框架层拿不到 `prisma generate` 的类型）。 */
interface StaffRow {
  id: string
  status: string
  roleIds: unknown
  dataScope: string
  isOwner: boolean
}

interface StaffDelegate {
  findFirst(args: unknown): Promise<StaffRow | null>
}

/** `Staff.roleIds` 是 Json 列，读出来可能是任何东西，收窄成 string[]。 */
function toRoleIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

const STAFF_STATUSES: readonly string[] = ['ACTIVE', 'DISABLED', 'LEFT']
const DATA_SCOPES: readonly string[] = ['ALL', 'SUB_TREE', 'SELF', 'CUSTOM']

/**
 * 默认实现：直接查 `Staff` 表。
 *
 * ## 为什么走 `prisma.raw` 而不是 `prisma.tenant`
 *
 * 鸡生蛋问题：租户隔离扩展要从上下文里取 `tenantId`，而**此刻上下文里的 tenantId
 * 还没写进去**——它正是这次查询要确认的东西。用 `prisma.tenant` 会直接抛
 * `TenantScopeError`。所以这里必须用 raw，并把 `tenantId` 作为显式的 where 条件
 * 自己写死（下面那行），隔离由这条 where 保证而不是由扩展保证。
 */
@Injectable()
export class PrismaMembershipProvider implements MembershipProvider {
  // raw-reason: 登录/鉴权跨租户找账号——成员关系查询本身就是「确定 tenantId」这一步，
  // 此时请求上下文里还没有 tenantId，prisma.tenant 必然抛 TenantScopeError。
  // 隔离由本方法显式写死的 where.tenantId 保证。
  constructor(@Inject(RawPrismaService) private readonly raw: RawPrismaService) {}

  async membershipById(accountId: string, tenantId: string): Promise<Membership | null> {
    const staff = (this.raw.client as Record<string, unknown>).staff as StaffDelegate | undefined
    if (!staff) {
      throw new Error(
        '[@taizan/nest-auth] Prisma 客户端上没有 staff 模型，schema 是否漏了 03-identity？',
      )
    }

    const row = await staff.findFirst({
      // raw-reason: 登录/鉴权跨租户找账号（同上）。tenantId 在这里是**入参**而非上下文，
      // 所以必须手写；no-manual-tenant-filter（spec 4）对本文件的豁免理由也是这一条。
      where: { accountId, tenantId, deletedAt: null },
      select: { id: true, status: true, roleIds: true, dataScope: true, isOwner: true },
    })
    if (!row) return null

    return {
      staffId: row.id,
      // 库里冒出没见过的枚举值时按最不危险的方向兜底：当成 DISABLED（拒绝），
      // 而不是当成 ACTIVE（放行）。失败关闭。
      status: (STAFF_STATUSES.includes(row.status) ? row.status : 'DISABLED') as StaffStatus,
      roleIds: toRoleIds(row.roleIds),
      // 同理，未知的 dataScope 收敛到最小范围 SELF。
      dataScope: (DATA_SCOPES.includes(row.dataScope) ? row.dataScope : 'SELF') as DataScope,
      isOwner: row.isOwner === true,
    }
  }

  /** 无缓存实现，空操作。缓存版见 {@link CachedMembershipProvider}。 */
  invalidate(_accountId: string, _tenantId: string): void {
    // no-op
  }
}

/** 缓存条目。 */
interface CacheEntry {
  at: number
  value: Membership | null
}

/** 缓存有效期。改这个值等于改「撤权最长多久生效」，属于安全参数。 */
export const MEMBERSHIP_TTL_MS = 30_000

/** 缓存容量上限。超了整体清空——LRU 的复杂度不值得为一个 30 秒缓存付。 */
export const MEMBERSHIP_CACHE_MAX = 5000

/**
 * 给任意 {@link MembershipProvider} 套一层 30 秒缓存。
 *
 * ## 为什么需要它
 *
 * 「每请求现查库」很正确但也很贵：商家后台一个页面能打十几个接口，每个都多一次
 * `Staff` 查询。30 秒缓存把命中率拉到 99% 以上，代价是撤权最长晚 30 秒生效。
 *
 * ## 为什么缓存 `null` 也存
 *
 * 被移出店铺的人如果还在页面上点，每一下都会穿透到库里查一次「他确实不在」。
 * 缓存 null 之后这类无效查询也被挡住了。
 *
 * ## 为什么不用 Redis
 *
 * 这是**热路径上的每请求查询**，进程内 Map 是纳秒级，Redis 是毫秒级；
 * 而缓存内容本身不需要跨实例一致（每个实例各自查库，各自最多脏 30 秒）。
 */
// process-local: 30 秒撤权延迟可接受，多实例靠 TTL 兜底
@Injectable()
export class CachedMembershipProvider implements MembershipProvider {
  // process-local: 30 秒撤权延迟可接受，多实例靠 TTL 兜底
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly inner: MembershipProvider,
    private readonly clock: Clock,
    private readonly ttlMs: number = MEMBERSHIP_TTL_MS,
  ) {}

  private static key(accountId: string, tenantId: string): string {
    return `${accountId}:${tenantId}`
  }

  async membershipById(accountId: string, tenantId: string): Promise<Membership | null> {
    const key = CachedMembershipProvider.key(accountId, tenantId)
    const hit = this.cache.get(key)
    const now = this.clock.now()
    if (hit && now - hit.at < this.ttlMs) {
      return hit.value
    }

    const value = await this.inner.membershipById(accountId, tenantId)
    if (this.cache.size > MEMBERSHIP_CACHE_MAX) {
      this.cache.clear()
    }
    this.cache.set(key, { at: now, value })
    return value
  }

  /**
   * 立即失效一条（本实例内）。
   *
   * 别的实例仍要等 {@link MEMBERSHIP_TTL_MS} 自然过期。想做到全实例秒级生效，
   * 得再引一条 Redis pub/sub 广播——那是一整套额外的失败模式（订阅断了就静默失效），
   * 为了 30 秒不划算。
   */
  invalidate(accountId: string, tenantId: string): void {
    this.cache.delete(CachedMembershipProvider.key(accountId, tenantId))
    this.inner.invalidate(accountId, tenantId)
  }

  /** 清空全部缓存（管理员「全局刷新权限」按钮、测试用）。 */
  clear(): void {
    this.cache.clear()
  }

  /** 当前缓存条目数（测试断言用）。 */
  get size(): number {
    return this.cache.size
  }
}
