/**
 * 员工邀请的**核销**端（T1-9）。
 *
 * ## 为什么它在 `/api/public` 而不是 `/api/admin`
 *
 * 被邀请人此刻**还不是这家店的员工**——他可能连账号都没有。要求他先登录才能接受邀请
 * 是个死循环。所以这条路径必须免登录，也就必须落在 `/api/public`
 * （`TENANT_FREE_PREFIXES`，租户中间件在这条前缀上根本不跑）。
 *
 * 代价是这里没有任何隐式上下文：`tenantId` 只能从**令牌本身**反查出来，
 * 于是全程 raw。这与 `public/signup` 是同一类处境（建店那一刻租户还不存在），
 * 也用同一条 raw 豁免类别。
 *
 * ## 配额扣在这里，不扣在发邀请时
 *
 * 邀请只是一张纸，人没来之前不占名额。扣在真的多出一个 `Staff` 行的这一刻。
 * `QuotaService.consume()` 从 `currentContext().tenantId` 取租户，而这条路由上没有——
 * 所以用 `runWithPatchedContext({ tenantId }, …)` 现开一个：**这不是绕过隔离**，
 * 那个 `tenantId` 来自数据库里那张邀请，不来自请求参数。
 *
 * ## 「先占坑再干活」的顺序
 *
 * ```
 * 校验邀请 → 解析/创建账号 → 查重成员关系 → 抢占邀请(usedAt) → 扣配额 → 建 Staff → 回填 usedBy
 *                                                    ↑ 失败就回滚上一步
 * ```
 *
 * 抢占放在扣配额之前，是因为**同一个令牌被并发提交两次**是真实会发生的
 * （用户手抖点两下）。`updateMany({ where: { id, usedAt: null } })` 的 `count`
 * 就是那把锁：只有一个请求拿得到 1，另一个拿到 0 直接被拒。
 * 反过来（先扣配额再抢占）的话，两个请求会各扣一次配额，其中一个白扣。
 *
 * ## 这条路由**不下发 token**
 *
 * 与 `public/signup` 同一条理由：在这里签 token 等于开了第二条进后台的路，
 * 而登录接口上的验证码、失败限流、账号停用判定这里一条都没有。
 * 加入成功后前端跳登录页，让他正常登录一次。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode, ulid } from '@taizan/contracts'
import { UNRESOLVABLE_TENANT_STATUSES } from '@taizan/nest-auth'
import { QuotaService } from '@taizan/nest-billing'
import { BizException, runWithPatchedContext } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import { hashPassword, hashPasswordSync, verifyPassword } from '@taizan/prisma-base'

import type { AppPrismaClient } from '../../../common/prisma.types'
import type { AcceptInviteDto } from './dto/invite.dto'

/** `GET /api/public/invites/:token` 的响应。 */
export interface InviteLookupResult {
  valid: boolean
  /** 无效时说明原因：`NOT_FOUND` / `USED` / `EXPIRED` / `SHOP_UNAVAILABLE`。有效时 `null`。 */
  reason: string | null
  /** 邀请人所在店铺的名字。无效时不下发（连店名都不该泄漏给一个乱猜令牌的人）。 */
  shopName: string | null
  /**
   * 限定的手机号，**打码后**下发（`138****0005`）。
   *
   * 不打码等于「拿一堆令牌就能批量收手机号」。打码之后前端仍然能提示
   * 「这张邀请只对尾号 0005 的手机号有效」，够用了。
   */
  phoneMask: string | null
  expiresAt: string | null
}

/** `POST /api/public/invites/:token/accept` 的响应。**刻意不含 token**。 */
export interface AcceptInviteResult {
  tenantId: string
  tenantSlug: string
  tenantName: string
  staffId: string
  /** 恒为 `false`，提醒调用方「这里没有 token，去登录」。 */
  loggedIn: false
}

/** 员工数配额的维度名（`QuotaKind.STAFF`）。 */
const STAFF_QUOTA_KIND = 'STAFF'

/** 见 `admin-auth.service.ts` 里同名常量：让「账号不存在」和「口令不对」两条分支耗时同档。 */
const DUMMY_HASH = hashPasswordSync(`unused-${Math.random()}`)

/** `13800000005` → `138****0005`。 */
function maskPhone(phone: string): string {
  return phone.length < 7 ? '***' : `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

@Injectable()
export class InviteService {
  constructor(
    // raw-reason: 登录/鉴权跨租户找账号——核销邀请时**还没有任何登录态与租户上下文**：
    // 这条路由在 /api/public（TENANT_FREE_PREFIXES）下，tenantId 是从邀请令牌反查出来的
    // **产物**而不是输入。`StaffAccount` / `Tenant` 本身也是平台域表（没有 tenantId 列）。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  /**
   * 查一张邀请还能不能用。
   *
   * 无效时**照常返回 200**（`valid: false` + 原因），不抛异常：这是一个给落地页
   * 用的探测接口，「过期了」是一个正常结果而不是一次错误。抛 4xx 会让前端在
   * 全局错误处理里弹一个红色 toast，而这一屏该显示的是「这张邀请已失效，请联系店主」。
   */
  async lookup(token: string): Promise<InviteLookupResult> {
    const invite = await this.findInvite(token)
    if (!invite) return invalid('NOT_FOUND')
    if (invite.usedAt !== null) return invalid('USED')
    if (invite.expiresAt.getTime() <= Date.now()) return invalid('EXPIRED')

    // raw-reason: 登录/鉴权跨租户找账号——Tenant 是平台域表，按邀请里的 tenantId 取店名。
    const tenant = await this.raw.client.tenant.findUnique({ where: { id: invite.tenantId } })
    if (!tenant || UNRESOLVABLE_TENANT_STATUSES.includes(tenant.status)) {
      return invalid('SHOP_UNAVAILABLE')
    }

    return {
      valid: true,
      reason: null,
      shopName: tenant.name,
      phoneMask: invite.phone === null ? null : maskPhone(invite.phone),
      expiresAt: invite.expiresAt.toISOString(),
    }
  }

  /**
   * 接受邀请：复用或创建 `StaffAccount` → 建 `Staff` → 核销令牌。
   *
   * @throws `BizException` 1040000 邀请无效/过期/已用/手机号不符/已经是本店员工；
   *   1140100 手机号已有账号但口令不对；1240400 店铺不可用；1540301 员工数配额已满
   */
  async accept(token: string, dto: AcceptInviteDto): Promise<AcceptInviteResult> {
    const invite = await this.findInvite(token)
    if (!invite) throw new BizException(ErrorCode.BAD_REQUEST, '邀请链接无效')
    if (invite.usedAt !== null) throw new BizException(ErrorCode.BAD_REQUEST, '这张邀请已经用过了')
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new BizException(ErrorCode.BAD_REQUEST, '邀请链接已过期，请让店主重新生成')
    }
    if (invite.phone !== null && invite.phone !== dto.phone) {
      throw new BizException(ErrorCode.BAD_REQUEST, '这张邀请只对指定手机号有效')
    }

    const tenantId = invite.tenantId
    // raw-reason: 登录/鉴权跨租户找账号——Tenant 是平台域表。
    const tenant = await this.raw.client.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant || UNRESOLVABLE_TENANT_STATUSES.includes(tenant.status)) {
      throw new BizException(ErrorCode.TENANT_NOT_FOUND, '这家店铺当前不可加入')
    }

    const account = await this.resolveAccount(dto)

    // raw-reason: 登录/鉴权跨租户找账号——查「这个账号在这家店里是不是已经有成员关系」。
    // tenantId 在这里是**入参**（来自邀请那一行）而不是上下文，所以必须手写；
    // 本目录不在 no-manual-tenant-filter（spec 4）的扫描范围内，正是为了这种场景。
    const already = await this.raw.client.staff.findFirst({
      where: { tenantId, accountId: account.id, deletedAt: null },
      select: { id: true },
    })
    if (already) {
      throw new BizException(ErrorCode.BAD_REQUEST, '你已经是这家店的员工了，直接登录即可')
    }

    // ── 抢占令牌。`count === 0` = 并发的另一个请求先拿到了。 ────────────────
    const claimed = await this.raw.client.staffInvite.updateMany({
      where: { id: invite.id, usedAt: null },
      data: { usedAt: new Date() },
    })
    if (claimed.count === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, '这张邀请已经用过了')
    }

    try {
      // 配额要在**这家店**的上下文里扣。`tenantId` 来自库里那张邀请，不来自请求。
      await runWithPatchedContext({ tenantId }, async () => {
        await this.quota.consume(STAFF_QUOTA_KIND)
      })
    } catch (error) {
      await this.releaseClaim(invite.id)
      throw error
    }

    let staffId: string
    try {
      // raw-reason: 登录/鉴权跨租户找账号——建成员关系这一刻还没有租户上下文
      // （这条路由免登录、在 TENANT_FREE_PREFIXES 下），tenantId 来自库里那张邀请，
      // 是从令牌反查出来的产物而不是请求参数。
      const staff = await this.raw.client.staff.create({
        data: {
          id: ulid(),
          tenantId,
          accountId: account.id,
          name: account.name,
          status: 'ACTIVE',
          roleIds: toStringArray(invite.roleIds),
          dataScope: 'SELF',
          isOwner: false,
        },
      })
      staffId = staff.id
    } catch (error) {
      // 补偿的顺序与占用相反。两个都可能失败，失败了也只是「配额虚高 + 一张作废的邀请」，
      // 不会丢业务数据——比留下一个半成品的 Staff 行好。
      await runWithPatchedContext({ tenantId }, async () => {
        await this.quota.release(STAFF_QUOTA_KIND)
      }).catch(() => undefined)
      await this.releaseClaim(invite.id)
      throw error
    }

    // 回填「是谁核销的」。这一步失败不回滚——人已经进来了，
    // 而 `usedAt` 已经落值（令牌确实作废了），少一个 `usedBy` 只是审计信息缺一块。
    // raw-reason: 登录/鉴权跨租户找账号——StaffInvite 按主键回填，此刻仍无租户上下文。
    await this.raw.client.staffInvite
      .update({ where: { id: invite.id }, data: { usedBy: account.id } })
      .catch(() => undefined)

    return {
      tenantId,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      staffId,
      loggedIn: false,
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /**
   * 复用已有账号或建一个新的。
   *
   * 已有账号时**必须验它现有的口令**——否则任何人拿到一张不限手机号的邀请链接，
   * 填上别人的手机号就把别人的账号挂进了自己的店（而且从此能用那个账号的名义操作）。
   * 这与 `public/signup` 的 `existingPassword` 是同一条规则，失败一律回 1140100，
   * 不区分「没有这个账号」与「口令不对」——区分了这个接口就是一个手机号枚举器。
   *
   * **永远不覆盖已有口令**。
   */
  private async resolveAccount(dto: AcceptInviteDto): Promise<{ id: string; name: string }> {
    // raw-reason: 登录/鉴权跨租户找账号——手机号是 StaffAccount 上的全局唯一键。
    const existing = await this.raw.client.staffAccount.findUnique({ where: { phone: dto.phone } })

    // 无论账号在不在都跑一次 scrypt，让两条分支耗时同档。
    const ok = await verifyPassword(dto.password, existing?.passwordHash ?? DUMMY_HASH)
    if (existing) {
      if (!ok || existing.status !== 'ACTIVE') {
        throw new BizException(ErrorCode.UNAUTHENTICATED, '手机号或密码不正确')
      }
      return { id: existing.id, name: existing.name }
    }

    // raw-reason: 登录/鉴权跨租户找账号——StaffAccount 是平台域表，建号这一刻还没有租户上下文。
    const created = await this.raw.client.staffAccount.create({
      data: {
        id: ulid(),
        phone: dto.phone,
        passwordHash: await hashPassword(dto.password),
        // 没有姓名字段可填，先用手机号后四位占位；他登录后可以在「个人设置」里改。
        name: `员工${dto.phone.slice(-4)}`,
        status: 'ACTIVE',
      },
    })
    return { id: created.id, name: created.name }
  }

  /** 把抢占放回去（补偿路径）。 */
  private async releaseClaim(inviteId: string): Promise<void> {
    // raw-reason: 登录/鉴权跨租户找账号——补偿路径同样跑在没有租户上下文的公开接口上。
    await this.raw.client.staffInvite
      .updateMany({ where: { id: inviteId }, data: { usedAt: null, usedBy: null } })
      .catch(() => undefined)
  }

  /** 按令牌取邀请。`token` 是全局唯一键，所以这一步天然跨租户。 */
  private async findInvite(token: string) {
    // raw-reason: 登录/鉴权跨租户找账号——邀请令牌是全局唯一键，
    // 「这张邀请属于哪家店」正是这一步要算出来的东西，此刻没有 tenantId 可用。
    return this.raw.client.staffInvite.findUnique({ where: { token } })
  }
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function invalid(reason: string): InviteLookupResult {
  return { valid: false, reason, shopName: null, phoneMask: null, expiresAt: null }
}
