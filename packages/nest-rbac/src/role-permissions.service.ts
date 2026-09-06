/**
 * 角色 → 已展开权限点集合，带 30 秒进程内缓存。
 *
 * `PermissionsGuard`（每请求）与 `BootstrapService`（每次登录/切店）共用这一份，
 * 保证「守卫放行的」和「bootstrap 下发的」永远是同一个集合——两边各算一遍的话，
 * 表现会是「菜单里看得到，点进去 403」，商家只会认为系统坏了。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { AuthPrincipal } from '@taizan/nest-auth'
import { modelDelegateOf, PrismaService } from '@taizan/nest-prisma'
import { expandRoles } from '@taizan/rbac-core'
import { PermissionRegistry } from './registry'
import { PERMISSION_REGISTRY, RBAC_CLOCK } from './tokens'

/** 时钟。与 `@taizan/nest-auth` 的 `Clock` 同形，测试里换成可推进的假时钟。 */
export interface RbacClock {
  now(): number
}

/** 默认时钟。 */
export const systemRbacClock: RbacClock = { now: () => Date.now() }

/**
 * 角色缓存有效期：30 秒（与 `@taizan/nest-auth` 的成员关系缓存同一档）。
 *
 * 取舍：改一个角色的权限点后，最坏 30 秒内老权限仍然生效。想立刻生效就在写入侧调
 * {@link RolePermissionsService.invalidateRoles}——角色编辑接口本来就知道自己改了哪个租户。
 */
export const ROLE_CACHE_TTL_MS = 30_000

/**
 * 缓存的角色行数上限。
 *
 * 超过就整体清空（而不是 LRU 逐条淘汰）：这是个 30 秒就过期的缓存，
 * 清空的代价是几条 `findMany`，而一个正确的 LRU 要多一份链表和一堆边界用例。
 */
export const ROLE_CACHE_MAX = 5_000

/** DB 里的一行 `Role`（只取判定用得着的两列）。 */
interface RoleRow {
  id: string
  /** Prisma `Json` 列，运行时是 `string[]`；脏数据（对象/字符串）由下面兜住。 */
  permissionCodes: unknown
}

/** 一条缓存。 */
interface CachedRole {
  codes: string[]
  expiresAt: number
}

function toCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

@Injectable()
export class RolePermissionsService {
  /**
   * process-local: 角色权限点的 30 秒缓存。
   *
   * 这是一个**每进程一份**的 Map，多实例部署时各实例各缓存各的，所以
   * {@link invalidateRoles} 只对本进程生效——跨实例的即时失效需要 Redis 广播，
   * 那是 T2-1（`@taizan/nest-infra`）的缓存层该干的事，本包不自己搭一套。
   * 在那之前，多实例下的最坏撤权延迟仍然是 {@link ROLE_CACHE_TTL_MS}（30 秒），
   * 与 `@taizan/nest-auth` 的成员关系缓存同一个量级，可接受。
   */
  private readonly cache = new Map<string, Map<string, CachedRole>>()

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PERMISSION_REGISTRY) private readonly permissions: PermissionRegistry,
    @Inject(RBAC_CLOCK) private readonly clock: RbacClock,
  ) {}

  /**
   * 算出一个主体的已授予权限点集合。
   *
   * - `platform`：返回全部已注册权限点（平台超管，见 `PermissionsGuard` 的 TSDoc）；
   * - `staff` 且 `isOwner`：`expandRoles(..., { ownerAll: true })` = 全部已注册权限点；
   * - `staff`：按 `principal.roleIds` 查 `Role` 表（**库里的角色，不是 token 里的**）
   *   再 `expandRoles` 取并集，通配 `'goods:*'` / `'*'` 在这一步展开；
   * - `member`：空集（C 端会员不参与后台 RBAC）。
   */
  async grantedFor(principal: AuthPrincipal): Promise<ReadonlySet<string>> {
    const allCodes = this.permissions.codes()

    if (principal.kind === 'platform') {
      return new Set(allCodes)
    }
    if (principal.kind !== 'staff') {
      return new Set<string>()
    }
    if (principal.isOwner === true) {
      return expandRoles([], { ownerAll: true, allCodes })
    }

    const tenantId = principal.tenantId
    const roleIds = principal.roleIds ?? []
    if (tenantId === undefined || roleIds.length === 0) {
      return new Set<string>()
    }

    const roles = await this.rolesOf(tenantId, roleIds)
    // strict 保持默认（宽松）：DB 里的历史脏 code 静默丢弃，方向是少给权限。
    return expandRoles(
      roles.map((codes) => ({ permissionCodes: codes })),
      { allCodes },
    )
  }

  /**
   * 取一批角色的 `permissionCodes`，命中缓存的不查库。
   *
   * @returns 每个**存在的**角色一项；查不到的角色 id 直接跳过（角色被删了 = 没有权限，
   *   不是错误——把它当错误会让一个删角色的操作把在线的人全部打成 500）
   */
  private async rolesOf(tenantId: string, roleIds: readonly string[]): Promise<string[][]> {
    const now = this.clock.now()
    const bucket = this.cache.get(tenantId) ?? new Map<string, CachedRole>()
    const hit: string[][] = []
    const missing: string[] = []

    for (const id of roleIds) {
      const cached = bucket.get(id)
      if (cached !== undefined && cached.expiresAt > now) {
        hit.push(cached.codes)
      } else {
        missing.push(id)
      }
    }

    if (missing.length === 0) return hit

    // Role 是【租户域】表，走 `prisma.tenant`：租户条件由扩展自动注入，
    // 这里一个字面量 `tenantId:` 都不写（蓝图 §8 spec 4）。
    const delegate = modelDelegateOf(this.prisma.tenant as object, 'role')
    const rows = (await delegate.findMany({
      where: { id: { in: missing } },
      select: { id: true, permissionCodes: true },
    })) as RoleRow[] | null

    const expiresAt = now + ROLE_CACHE_TTL_MS
    for (const row of rows ?? []) {
      const codes = toCodes(row.permissionCodes)
      bucket.set(row.id, { codes, expiresAt })
      hit.push(codes)
    }
    // 查不到的角色也记一条空缓存，避免「引用了已删角色的员工」每请求都打一次库。
    for (const id of missing) {
      if (!bucket.has(id)) bucket.set(id, { codes: [], expiresAt })
    }

    this.cache.set(tenantId, bucket)
    this.evictIfOversized()
    return hit
  }

  /**
   * 让缓存立即失效。
   *
   * @param tenantId - 只失效这个租户；不传则清空全部（用于测试与「同步了新权限点」之类的全局事件）
   */
  invalidateRoles(tenantId?: string): void {
    if (tenantId === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(tenantId)
  }

  /** 当前缓存的角色行数（测试与 `/health` 用）。 */
  get cachedRoleCount(): number {
    let total = 0
    for (const bucket of this.cache.values()) total += bucket.size
    return total
  }

  private evictIfOversized(): void {
    if (this.cachedRoleCount > ROLE_CACHE_MAX) this.cache.clear()
  }
}
