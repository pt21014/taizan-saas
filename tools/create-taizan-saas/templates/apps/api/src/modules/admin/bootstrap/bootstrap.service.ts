/**
 * `GET /api/admin/auth/bootstrap` —— 前端登录/切店后**只调这一个接口**就能把后台画出来。
 *
 * ## 这一层做什么、不做什么
 *
 * 组装 `permissions` / `menus` 的逻辑**不在这里**，在 `@taizan/nest-rbac` 的
 * `BootstrapService`（下面注入的 `rbac`）。理由是那两样必须和 `PermissionsGuard`
 * 用**同一份** `granted` 集合：两边各算一遍的话，表现会是「菜单里看得到，点进去 403」，
 * 而商家只会认为系统坏了。
 *
 * 本文件负责的是那些**只有应用才知道**的东西：
 *
 * | 字段 | 从哪来 | 为什么不在框架包里 |
 * |---|---|---|
 * | `identity` | `Staff` + `StaffAccount` | 展示名/头像存在哪张表是应用的决定 |
 * | `tenant.readonly` / `closedReason` | `evaluateTenantGate`（经 `PlatformGateway`） | 闸门要不要算、按哪一侧算，是应用的决定 |
 * | `tenant.features` | `Plan.features`（经 `PlatformGateway`） | 同上 |
 * | `shops` | `AdminAuthService.shopsOf` | 一号多店的口径是应用的 |
 * | `quotas` | `QuotaService.usage` | 这个应用关心哪几档配额，只有它知道 |
 *
 * ## `readonly` 是「算出来」的，不是库里的一列
 *
 * 蓝图 §4.5 第一条不可退让：到期永远现算，不落 `EXPIRED` 状态位。所以这里跑一次
 * `evaluateTenantGate({ side: 'ADMIN' })` 而不是读某个字段。它和
 * `BillingGateGuard` 用的是同一个纯函数、同一份闸门视图（`PlatformGateway` 的
 * 30 秒缓存），所以「前端以为能写」和「后端真的让不让写」不会打架。
 *
 * 一处**刻意的不对称**：`readonly` 表达的是「写操作会不会被拦」，但续费白名单
 * （`/api/admin/auth|billing|bootstrap`）在任何闸门下都可写。前端据此把整个表单区
 * 置灰、同时保留「去续费」按钮即可——所以下发里还带了 `closedReason`，
 * 让它能把提示写成「已冻结，请联系平台」而不是一律「请续费」。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { BootstrapQuota, BootstrapResponse } from '@taizan/contracts'
import { ErrorCode } from '@taizan/contracts'
import { evaluateTenantGate } from '@taizan/billing-rules'
import type { AuthPrincipal } from '@taizan/nest-auth'
import { PLATFORM_GATEWAY, QuotaService, gateInputOf } from '@taizan/nest-billing'
import type { PlatformGateway, TenantGateView } from '@taizan/nest-billing'
import { BizException } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import { BootstrapService as RbacBootstrapService } from '@taizan/nest-rbac'

import type { AppPrismaClient } from '../../../common/prisma.types'
import { BOOTSTRAP_QUOTA_KINDS } from '../../../registry/quota-kinds'
import { AdminAuthService } from '../auth/admin-auth.service'

@Injectable()
export class BootstrapService {
  constructor(
    // raw-reason: 登录/鉴权跨租户找账号——`Tenant` 与 `StaffAccount` 是平台域表
    // （没有 tenantId 列），走 prisma.tenant 会被隔离扩展当成未登记模型 / 直接查不到。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(RbacBootstrapService) private readonly rbac: RbacBootstrapService,
    @Inject(PLATFORM_GATEWAY) private readonly gateway: PlatformGateway,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  /**
   * 组装 bootstrap 响应。
   *
   * @param principal - 当前 staff 主体（`GlobalAuthGuard` 已经用库里的成员关系覆盖过它）
   */
  async build(principal: AuthPrincipal): Promise<BootstrapResponse> {
    const tenantId = principal.tenantId
    const accountId = principal.accountId
    if (!tenantId || !accountId) {
      // staff token 一定同时有这两个字段（守卫已经查过一遍）。走到这里说明装配出了问题。
      throw new BizException(ErrorCode.UNAUTHENTICATED, '登录状态已失效，请重新登录')
    }

    // raw-reason: 平台域表 Tenant / StaffAccount 没有 tenantId 列，且这里读的就是
    // 「我当前这家店本身」的元信息，隔离由 principal.tenantId（来自 token）保证。
    const [tenant, account, view] = await Promise.all([
      this.raw.client.tenant.findUnique({ where: { id: tenantId } }),
      this.raw.client.staffAccount.findUnique({ where: { id: accountId } }),
      this.gateway.getTenant(tenantId),
    ])
    if (!tenant) {
      throw new BizException(ErrorCode.TENANT_NOT_FOUND, '当前店铺不存在或已被注销')
    }

    const gate = this.evaluateGate(view)
    const features = view?.features ?? null

    return this.rbac.buildBootstrap(principal, {
      identity: {
        staffId: principal.id,
        accountId,
        name: account?.name ?? '',
        avatar: account?.avatar ?? null,
        isOwner: principal.isOwner === true,
      },
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        planExpireAt: tenant.planExpireAt?.toISOString() ?? null,
        readonly: gate.readonly,
        closedReason: gate.closedReason,
        features,
      },
      shops: (await this.auth.shopsOf(accountId)).map((s) => ({
        tenantId: s.tenantId,
        name: s.name,
        slug: s.slug,
      })),
      // **三态必须原样传**：`null` = 不做 feature 裁剪。在这里把它归一化成 `[]`
      // 会把「没有套餐限制」变成「什么都没买」，商家登录进去会看到一个空后台。
      features,
      quotas: await this.quotas(),
    })
  }

  /**
   * 算「后台是不是只读」。
   *
   * **永远按 `enforcing: true` 算**，与 `BillingGateGuard` 的行为刻意不同：
   * 守卫要决定「这次请求放不放行」，所以它看真实开关；而这里下发给前端的是
   * 「你的店现在是什么状态」。`BILLING_ENFORCE=false` 是平台自己的灰度开关，
   * 不该让一家已经到期的店在后台上显示成一切正常——那样商家永远不会去续费，
   * 而平台打开开关那天他会觉得系统突然坏了。
   *
   * 代价是开关关着时前端会把表单置灰、后端却仍然放行。这个方向是安全的
   * （少给），而且正是灰度期想要的：先让商家看到提示，再真的开始拦。
   */
  private evaluateGate(view: TenantGateView | null): {
    readonly: boolean
    closedReason: string | null
  } {
    if (view === null) return { readonly: false, closedReason: null }
    const result = evaluateTenantGate(gateInputOf(view, new Date(), true))
    return {
      readonly: !result.adminWritable,
      // `closedReason` 说的是 C 端打没打烊，与后台只读是两件事：宽限期内后台只读、
      // C 端照常营业，前端要能分别提示。
      closedReason: result.clientOpen ? null : result.reason,
    }
  }

  /**
   * 配额用量快照。
   *
   * 逐档 `usage()` 而不是一次性拿全表：`QuotaCounter` 里可能有历史遗留的 kind，
   * 而前端顶栏只该显示这个应用**真的在用**的那几档（见 `registry/quota-kinds.ts`）。
   * 多几次查询换一个稳定的下发形状，值得。
   */
  private async quotas(): Promise<Record<string, BootstrapQuota>> {
    const entries = await Promise.all(
      BOOTSTRAP_QUOTA_KINDS.map(async (kind) => {
        const usage = await this.quota.usage(kind)
        return [kind, { used: usage.used, limit: usage.limit }] as const
      }),
    )
    return Object.fromEntries(entries)
  }
}
