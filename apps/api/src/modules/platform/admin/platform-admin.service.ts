/**
 * 平台管理员 CRUD（T1-7）。
 *
 * `PlatformAdmin` 是平台域表（没有 `tenantId` 列），本文件全程走 `RawPrismaService`
 * ——理由与 `tenant/platform-tenant.service.ts` 文件头一致，属于 `raw-reasons.ts` 里
 * `src/modules/platform/` 整目录的豁免，不必再单独登记。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode, normalizePage, ulid, type PageResult } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import { SessionService } from '@taizan/nest-auth'
import { hashPassword } from '@taizan/prisma-base'

import type { AppPrismaClient } from '../../../common/prisma.types'
import { randomPassword } from '../shared/random-password'
import type {
  CreateAdminDto,
  ListAdminQueryDto,
  SetAdminPasswordDto,
  UpdateAdminDto,
} from './dto/platform-admin.dto'

/** 下发给平台后台的管理员行（**不含** `passwordHash` / `mfaSecretEnc`）。 */
export interface AdminView {
  id: string
  username: string
  name: string
  status: string
  roleIds: string[]
  lastLoginAt: string | null
  createdAt: string
}

/** 创建/重置口令的产出：只在**没有显式指定口令**时回明文，交给调用方线下转告。 */
export interface AdminSecretResult {
  admin: AdminView
  initialPassword: string | null
}

/** 一行 `PlatformAdmin`（Prisma 生成的行类型，借 `findUnique` 的返回值收窄非空后的形状）。 */
type PlatformAdminRow = NonNullable<
  Awaited<ReturnType<AppPrismaClient['platformAdmin']['findUnique']>>
>

function toRoleIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : []
}

function toView(row: {
  id: string
  username: string
  name: string
  status: string
  roleIds: unknown
  lastLoginAt: Date | null
  createdAt: Date
}): AdminView {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    status: row.status,
    roleIds: toRoleIds(row.roleIds),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

@Injectable()
export class PlatformAdminService {
  constructor(
    // raw-reason: 平台后台——PlatformAdmin 是平台域表，没有 tenantId 列。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async list(query: ListAdminQueryDto): Promise<PageResult<AdminView>> {
    const { page, pageSize } = normalizePage(query)
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.keyword
        ? {
            OR: [{ username: { contains: query.keyword } }, { name: { contains: query.keyword } }],
          }
        : {}),
    }

    // raw-reason: 平台后台——跨的不是租户，是「平台自己这张表」本来就没有租户维度。
    const [rows, total] = await Promise.all([
      this.raw.client.platformAdmin.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.raw.client.platformAdmin.count({ where }),
    ])
    return { items: rows.map(toView), total, page, pageSize }
  }

  async get(id: string): Promise<AdminView> {
    return toView(await this.requireAdmin(id))
  }

  /** @throws `BizException` 1040000 用户名已被占用 / roleIds 引用了不存在的平台角色预设 */
  async create(dto: CreateAdminDto): Promise<AdminSecretResult> {
    // raw-reason: 平台后台——用户名全局唯一性检查，PlatformAdmin 无租户维度。
    const taken = await this.raw.client.platformAdmin.findUnique({
      where: { username: dto.username },
    })
    if (taken)
      throw new BizException(ErrorCode.BAD_REQUEST, `用户名「${dto.username}」已经被占用了`)

    const roleIds = dto.roleIds ?? []
    await this.assertRoleIdsValid(roleIds)

    const initialPassword = dto.password ?? randomPassword()
    const passwordHash = await hashPassword(initialPassword)

    // raw-reason: 平台后台——新建平台管理员，无租户维度。
    const row = await this.raw.client.platformAdmin.create({
      data: {
        id: ulid(),
        username: dto.username,
        passwordHash,
        name: dto.name,
        status: 'ACTIVE',
        roleIds,
      },
    })

    return { admin: toView(row), initialPassword: dto.password ? null : initialPassword }
  }

  async update(id: string, dto: UpdateAdminDto): Promise<AdminView> {
    await this.requireAdmin(id)
    if (dto.roleIds !== undefined) await this.assertRoleIdsValid(dto.roleIds)

    // raw-reason: 平台后台——修改平台管理员，无租户维度。
    const row = await this.raw.client.platformAdmin.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.roleIds !== undefined ? { roleIds: dto.roleIds } : {}),
      },
    })
    return toView(row)
  }

  /**
   * 重置某个管理员的登录口令，并吊销他的全部会话——不这么做的话，被重置口令的人
   * 手上那张还没过期的旧 token 仍然能用，"重置口令" 就成了一句空话。
   */
  async setPassword(id: string, dto: SetAdminPasswordDto): Promise<AdminSecretResult> {
    const admin = await this.requireAdmin(id)
    const newPassword = dto.newPassword ?? randomPassword()
    const passwordHash = await hashPassword(newPassword)

    // raw-reason: 平台后台——重置管理员口令，无租户维度。
    const row = await this.raw.client.platformAdmin.update({
      where: { id },
      data: { passwordHash },
    })
    await this.sessions.revokeAll('platform', admin.id)

    return { admin: toView(row), initialPassword: dto.newPassword ? null : newPassword }
  }

  async enable(id: string): Promise<AdminView> {
    await this.requireAdmin(id)
    // raw-reason: 平台后台——启用管理员，无租户维度。
    const row = await this.raw.client.platformAdmin.update({
      where: { id },
      data: { status: 'ACTIVE' },
    })
    return toView(row)
  }

  /**
   * 停用一个管理员。
   *
   * 两条硬约束（蓝图之外，T1-7 明确要求）：
   * - **不能停用自己**——那会让操作者当场把自己锁在门外，还得找另一个管理员来救；
   * - **不能停用最后一个 ACTIVE 管理员**——那等于把整个平台后台锁死，
   *   没有物理删除入口（`PlatformAdmin` 不是软删表），这里的「停用」就是平台后台
   *   唯一会让一个管理员彻底失去登录能力的操作，所以按"删除最后一个"的分量来挡。
   *
   * @param actingAdminId - 当前操作者自己的 id
   */
  async disable(id: string, actingAdminId: string): Promise<AdminView> {
    if (id === actingAdminId) {
      throw new BizException(ErrorCode.BAD_REQUEST, '不能停用自己')
    }
    const target = await this.requireAdmin(id)
    if (target.status === 'ACTIVE') {
      // raw-reason: 平台后台——数一数还有几个能登录的管理员，无租户维度。
      const activeCount = await this.raw.client.platformAdmin.count({ where: { status: 'ACTIVE' } })
      if (activeCount <= 1) {
        throw new BizException(ErrorCode.BAD_REQUEST, '不能停用最后一个可登录的平台管理员')
      }
    }

    // raw-reason: 平台后台——停用管理员，无租户维度。
    const row = await this.raw.client.platformAdmin.update({
      where: { id },
      data: { status: 'DISABLED' },
    })
    await this.sessions.revokeAll('platform', id)
    return toView(row)
  }

  private async requireAdmin(id: string): Promise<PlatformAdminRow> {
    // raw-reason: 平台后台——按 id 取管理员，无租户维度。
    const row = await this.raw.client.platformAdmin.findUnique({ where: { id } })
    if (!row) throw new BizException(ErrorCode.BAD_REQUEST, '管理员不存在')
    return row
  }

  /**
   * `roleIds` 必须都是已存在的 `RolePreset.id` 且 `side = PLATFORM`——
   * 挂一个不存在的模板上去，权限执行层（T1-2）落地那天这个管理员会安静地什么权限都没有。
   */
  private async assertRoleIdsValid(roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return
    // raw-reason: 平台后台——校验角色预设 id 是否存在，无租户维度。
    const rows = await this.raw.client.rolePreset.findMany({
      where: { id: { in: roleIds }, side: 'PLATFORM' },
      select: { id: true },
    })
    const found = new Set(rows.map((r) => r.id))
    const missing = roleIds.filter((id) => !found.has(id))
    if (missing.length > 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `以下角色预设不存在或不属于平台侧：${missing.join(', ')}`,
      )
    }
  }
}
