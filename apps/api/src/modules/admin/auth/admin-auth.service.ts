/**
 * 商家员工登录 / 换店 / 登出。
 *
 * ## 一号多店的登录形状
 *
 * 商家只会输手机号和口令，他没有「店铺 id」这个概念。所以登录分两步：
 *
 * 1. 只给手机号 + 口令 → 服务端算出这个账号名下**所有可用店铺**：
 *    - 恰好一家 → 直接签 token 进去（绝大多数商家的日常）；
 *    - 多家 → **不签 token**，回一个店铺列表让前端选，选完再带 `tenantId` 打一次。
 * 2. 带了 `tenantId` → 校验成员关系后签 token。
 *
 * 「多家店时不签 token」是刻意的：先签一个进 A 店再让他换到 B 店，等于每次登录都
 * 白建一次会话（还会占用并发端数），而且用户会看见界面闪一下 A 店的数据。
 *
 * ## staff token 一次只绑一家店
 *
 * 蓝图 §4.3 的不变量。换店走 {@link AdminAuthService.switchTenant} **重签**，
 * 不是「改 token 里的 tenantId」——token 签过名，改不了；更本质的原因是一个能同时
 * 代表多家店的 token 会让每一处隔离判断都要多问一句「这次是哪家」。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode } from '@taizan/contracts'
import {
  AuthFlowService,
  UNRESOLVABLE_TENANT_STATUSES,
  type AuthPrincipal,
  type StaffLoginResult,
} from '@taizan/nest-auth'
import { BizException } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import { hashPassword, hashPasswordSync, needsRehash, verifyPassword } from '@taizan/prisma-base'

import type { AppPrismaClient } from '../../../common/prisma.types'

/** 一号多店时回给前端的店铺条目。 */
export interface ShopChoice {
  tenantId: string
  name: string
  slug: string
  /** 这个账号在这家店里是不是店主，前端可以给个标记。 */
  isOwner: boolean
}

/** 登录结果：要么拿到 token，要么拿到一张选店列表。 */
export type AdminLoginResult =
  | {
      /** 直接登录成功。 */
      needChooseShop: false
      access: string
      refresh: string
      expiresIn: number
      staffId: string
      tenantId: string
      shops: ShopChoice[]
    }
  | {
      /** 名下多家店，前端要让用户选一家再带 `tenantId` 打一次。**这一支没有 token**。 */
      needChooseShop: true
      shops: ShopChoice[]
    }

/** 见 `platform-auth.service.ts` 里同名常量的说明：为了让两条分支耗时同档。 */
const DUMMY_HASH = hashPasswordSync(`unused-${Math.random()}`)

@Injectable()
export class AdminAuthService {
  constructor(
    // raw-reason: 登录跨租户找账号——用户只输了手机号，此刻还不知道他属于哪家店；
    // 「他有哪些店」正是这一步要算出来的东西，prisma.tenant 在这里必然抛 NO_CONTEXT。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(AuthFlowService) private readonly flow: AuthFlowService,
  ) {}

  /**
   * 手机号 + 口令登录。
   *
   * @param phone - 手机号（`StaffAccount.phone`，全局唯一）
   * @param password - 明文口令
   * @param tenantId - 指定进哪家店；不给则按名下店铺数量决定直登还是让前端选
   * @throws `BizException` 1140100 账号不存在 / 口令不对 / 账号停用 / 名下没有可用店铺
   */
  async login(phone: string, password: string, tenantId?: string): Promise<AdminLoginResult> {
    // raw-reason: 登录跨租户找账号——手机号是平台域的全局唯一键。
    const account = await this.raw.client.staffAccount.findUnique({ where: { phone } })

    // 无论账号在不在都跑一次 scrypt，理由同 platform-auth.service.ts。
    const okPassword = await verifyPassword(password, account?.passwordHash ?? DUMMY_HASH)
    if (!account || !okPassword || account.status !== 'ACTIVE') {
      // 三种情况同一句文案：区分开就等于提供一个手机号是否注册过的探测器。
      throw new BizException(ErrorCode.UNAUTHENTICATED, '手机号或密码不正确')
    }

    if (needsRehash(account.passwordHash)) {
      // raw-reason: 登录跨租户找账号——StaffAccount 是平台域表。
      await this.raw.client.staffAccount.update({
        where: { id: account.id },
        data: { passwordHash: await hashPassword(password) },
      })
    }

    const shops = await this.shopsOf(account.id)
    if (shops.length === 0) {
      throw new BizException(
        ErrorCode.UNAUTHENTICATED,
        '这个账号名下没有可用的店铺，请联系店主或平台客服',
      )
    }

    if (tenantId !== undefined) {
      // 目标店必须在**服务端算出来的**列表里。拿前端传来的 tenantId 直接去签 token
      // 就是把「他有哪些店」的判断交给了客户端，那是一条越权入口。
      if (!shops.some((s) => s.tenantId === tenantId)) {
        throw new BizException(ErrorCode.UNAUTHENTICATED, '这家店铺不在你名下')
      }
      return this.issue(account.id, tenantId, shops)
    }

    const only = shops.length === 1 ? shops[0] : undefined
    if (only) return this.issue(account.id, only.tenantId, shops)

    return { needChooseShop: true, shops }
  }

  /** 换店：重签一个绑到目标店的新 token。旧 token 不吊销（蓝图附录第 5 条的取舍）。 */
  async switchTenant(
    principal: AuthPrincipal,
    targetTenantId: string,
  ): Promise<AdminLoginResult & { needChooseShop: false }> {
    if (!principal.accountId) {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '当前身份不是商家员工')
    }
    const shops = await this.shopsOf(principal.accountId)
    if (!shops.some((s) => s.tenantId === targetTenantId)) {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '这家店铺不在你名下')
    }
    // 走框架的 switchTenant 而不是自己再签一次：成员关系校验、会话登记、
    // 并发端数淘汰这三件事都在那里，绕过去就会少做其中某一件。
    const issued = await this.flow.switchTenant(principal, targetTenantId)
    return this.toResult(issued, shops)
  }

  /** 登出当前这一条会话。其它端不受影响（手机上退出登录不该把收银台踢掉）。 */
  async logout(principal: AuthPrincipal): Promise<void> {
    await this.flow.logout(principal)
  }

  /**
   * 算出一个账号名下**当前可用**的店铺。
   *
   * 两层过滤，都不能少：
   * - `Staff` 必须 ACTIVE 且未软删（被移出店铺的人不该还能选进去）；
   * - `Tenant` 不能是 SUSPENDED / DEREGISTERED（与 `SlugHeaderResolver` 用同一份
   *   {@link UNRESOLVABLE_TENANT_STATUSES}，两处判断口径必须一致，否则会出现
   *   「登录进去了但每个接口都 1240400」的鬼状态）。
   */
  async shopsOf(accountId: string): Promise<ShopChoice[]> {
    // raw-reason: 登录跨租户找账号——「这个账号在哪些租户里有成员关系」的查询
    // 天然跨租户；tenantId 是这次查询的**产物**而不是输入。
    const memberships = await this.raw.client.staff.findMany({
      where: { accountId, status: 'ACTIVE' },
      select: { tenantId: true, isOwner: true },
    })
    if (memberships.length === 0) return []

    // raw-reason: 登录跨租户找账号——按上面算出的 id 集合读租户元信息。
    const tenants = await this.raw.client.tenant.findMany({
      where: { id: { in: memberships.map((m) => m.tenantId) } },
      select: { id: true, name: true, slug: true, status: true },
    })
    const usable = new Map(
      tenants
        .filter((t) => !UNRESOLVABLE_TENANT_STATUSES.includes(t.status))
        .map((t) => [t.id, t] as const),
    )

    return memberships
      .map((m) => {
        const tenant = usable.get(m.tenantId)
        return tenant
          ? { tenantId: tenant.id, name: tenant.name, slug: tenant.slug, isOwner: m.isOwner }
          : null
      })
      .filter((s): s is ShopChoice => s !== null)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }

  private async issue(
    accountId: string,
    tenantId: string,
    shops: ShopChoice[],
  ): Promise<AdminLoginResult & { needChooseShop: false }> {
    return this.toResult(await this.flow.loginStaff(accountId, tenantId), shops)
  }

  private toResult(
    issued: StaffLoginResult,
    shops: ShopChoice[],
  ): AdminLoginResult & { needChooseShop: false } {
    return {
      needChooseShop: false,
      access: issued.access,
      refresh: issued.refresh,
      expiresIn: issued.expiresIn,
      staffId: issued.staffId,
      tenantId: issued.tenantId,
      shops,
    }
  }
}
