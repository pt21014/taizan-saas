/**
 * 「个人设置」——员工改自己的资料与密码（T1-9）。
 *
 * ## 两张表，两个「名字」
 *
 * | 字段 | 在哪张表 | 谁看得到 |
 * |---|---|---|
 * | 显示名 / 头像 / 手机号 | `StaffAccount`（**平台域**，一号多店共用一份） | 所有店的顶栏 |
 * | 店内昵称 `Staff.name` | `Staff`（租户域，每家店一份） | 那家店的员工列表 |
 *
 * 本接口改的是**账号级**的那份——因为 bootstrap 下发的 `identity.name` / `identity.avatar`
 * 取自 `StaffAccount`（见 `bootstrap.service.ts`），改店内昵称不会让顶栏变。
 * 店内昵称由「员工管理」那一页改（`PATCH /api/admin/staff/:id`），两个入口各改各的，
 * 不互相覆盖——一个人在 A 店叫「小王」在 B 店叫「王经理」是正常需求。
 *
 * ## 改密即全端撤销，而且是**跨店**全撤
 *
 * 蓝图 §4.3。改密的动机通常就是「我怀疑号被盗了」，这时候还留着别的端在线，
 * 改密就白改了。而一号多店意味着同一个 `StaffAccount` 在不同店里有不同的 `Staff.id`，
 * 会话是按 `Staff.id` 登记的（`AuthFlowService.loginStaff` 里 `sessions.add('staff', staffId, …)`）
 * ——只撤当前这家店的会话，攻击者拿着 B 店的 token 照样在线。所以这里先把这个账号
 * 名下**所有**店的 `Staff.id` 查出来，逐个 `revokeAll`。
 *
 * **顺序**：先写库、后清会话。反过来的话，清完会话到写库成功之间进程挂了，
 * 用户会用着旧口令但被踢下线，而他不知道为什么。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode } from '@taizan/contracts'
import { SessionService, type AuthPrincipal } from '@taizan/nest-auth'
import { BizException } from '@taizan/nest-core'
import { PrismaService, RawPrismaService } from '@taizan/nest-prisma'
import { hashPassword, verifyPassword } from '@taizan/prisma-base'

import type { AppPrismaClient, AppPrismaService } from '../../../common/prisma.types'
import type { ChangePasswordDto, UpdateProfileDto } from './dto/profile.dto'

/** `GET /api/admin/profile` 的响应。 */
export interface ProfileView {
  /** `StaffAccount.id`。 */
  accountId: string
  /** 当前这家店里的 `Staff.id`。 */
  staffId: string
  phone: string
  /** 账号显示名（顶栏那个）。 */
  name: string
  avatar: string | null
  /** 店内昵称，可能与 `name` 不同。 */
  staffName: string
  isOwner: boolean
  roleIds: string[]
  roleNames: string[]
  dataScope: string
  joinedAt: string
}

/** 改密的结果。 */
export interface ChangePasswordResult {
  /** 恒为 `true`。留一个字段是为了前端能确认这不是一个 204 空响应。 */
  ok: true
  /** 一共撤掉了几家店的会话（一号多店时 > 1）。前端可以据它提示「已在 N 处登出」。 */
  revokedStaffCount: number
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

@Injectable()
export class AdminProfileService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    // raw-reason: 登录/鉴权跨租户找账号——`StaffAccount` 是平台域表（一号多店的载体，
    // 没有 tenantId 列）；改密时还要跨租户列出「这个账号在哪些店里有 Staff 行」，
    // 才能把所有店的会话一起撤掉。两处查询都不带 tenantId 过滤条件。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async get(principal: AuthPrincipal): Promise<ProfileView> {
    const { staff, account } = await this.load(principal)
    const roleIds = toStringArray(staff.roleIds)
    const roles =
      roleIds.length === 0
        ? []
        : await this.prisma.tenant.role.findMany({
            where: { id: { in: roleIds } },
            select: { id: true, name: true },
          })

    return {
      accountId: account.id,
      staffId: staff.id,
      phone: account.phone,
      name: account.name,
      avatar: account.avatar,
      staffName: staff.name,
      isOwner: staff.isOwner,
      roleIds,
      roleNames: roles.map((r) => r.name),
      dataScope: staff.dataScope,
      joinedAt: staff.joinedAt.toISOString(),
    }
  }

  /** 改显示名 / 头像。传空串的 `avatar` 落成 `null`（清空），不是空字符串。 */
  async update(principal: AuthPrincipal, dto: UpdateProfileDto): Promise<ProfileView> {
    const { account } = await this.load(principal)

    // raw-reason: 登录/鉴权跨租户找账号——StaffAccount 是平台域表，按主键改自己那一行。
    await this.raw.client.staffAccount.update({
      where: { id: account.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.avatar !== undefined ? { avatar: dto.avatar === '' ? null : dto.avatar } : {}),
      },
    })
    return this.get(principal)
  }

  /**
   * 改密码。
   *
   * @throws `BizException` 1140100 旧密码不对；1040000 新旧密码相同
   */
  async changePassword(
    principal: AuthPrincipal,
    dto: ChangePasswordDto,
  ): Promise<ChangePasswordResult> {
    const { account } = await this.load(principal)

    const ok = await verifyPassword(dto.oldPassword, account.passwordHash)
    if (!ok) {
      // 刻意不说「旧密码错误」以外的任何东西，也不透露账号状态——这条路由带着有效
      // token，账号存在性本来就不是秘密，但保持与登录接口同一套文案更省心。
      throw new BizException(ErrorCode.UNAUTHENTICATED, '当前密码不正确')
    }
    if (dto.oldPassword === dto.newPassword) {
      throw new BizException(ErrorCode.BAD_REQUEST, '新密码不能与当前密码相同')
    }

    // 先写库。
    // raw-reason: 登录/鉴权跨租户找账号——口令存在平台域表 StaffAccount 上。
    await this.raw.client.staffAccount.update({
      where: { id: account.id },
      data: { passwordHash: await hashPassword(dto.newPassword) },
    })

    // 再清会话——**跨店全撤**，见文件头。
    // raw-reason: 登录/鉴权跨租户找账号——「这个账号在哪些店里有 Staff 行」天然跨租户，
    // tenantId 是这次查询的产物而不是输入。
    const memberships = await this.raw.client.staff.findMany({
      where: { accountId: account.id },
      select: { id: true },
    })
    // 兜底把当前这条也算上：`principal.id` 一定在上面的结果里，除非成员关系刚被删
    // （那时他下一个请求本来也会 401）。用 Set 去重，别撤两遍。
    const staffIds = new Set([principal.id, ...memberships.map((m) => m.id)])
    for (const staffId of staffIds) {
      await this.sessions.revokeAll('staff', staffId)
    }

    return { ok: true, revokedStaffCount: staffIds.size }
  }

  /** 取「当前这家店里的我」+「我的账号」。 */
  private async load(principal: AuthPrincipal): Promise<{
    staff: NonNullable<Awaited<ReturnType<AppPrismaClient['staff']['findFirst']>>>
    account: NonNullable<Awaited<ReturnType<AppPrismaClient['staffAccount']['findUnique']>>>
  }> {
    // `Staff` 是租户域表：走 prisma.tenant，租户条件由扩展注入，这里只按 id 找自己。
    const staff = await this.prisma.tenant.staff.findFirst({ where: { id: principal.id } })
    // raw-reason: 登录/鉴权跨租户找账号——StaffAccount 是平台域表，按主键取自己那一行。
    const account = staff
      ? await this.raw.client.staffAccount.findUnique({ where: { id: staff.accountId } })
      : null

    if (!staff || !account) {
      // 走到这里说明成员关系或账号在本次请求期间被删了（守卫刚刚还查到过）。
      throw new BizException(ErrorCode.UNAUTHENTICATED, '登录状态已失效，请重新登录')
    }
    return { staff, account }
  }
}
