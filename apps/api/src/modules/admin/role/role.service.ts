/**
 * 商家后台的自定义角色（T1-9）。
 *
 * `Role` 是【租户域】表，全程 `prisma.tenant`，一处 `tenantId` 都不写。
 *
 * ## 三条不可退让的校验
 *
 * 1. **权限点必须已注册**。写一个拼错的 code 进 `Role.permissionCodes` 不会报错，
 *    只会让那个角色多出一个永远不命中的权限——运营勾了它以为开了什么。
 *    校验对象是运行时的 `PERMISSION_REGISTRY`，与 `PermissionsGuard` 判定时用的
 *    **同一份**，所以「配得上」和「拦不拦」不会分叉。
 * 2. **不许出现 `platform-*`**。平台侧权限点（`platform-tenant:list` 之类）确实在
 *    同一张注册表里（一个进程装了两侧的路由），但把它配进一个商家角色是没有意义的：
 *    `/api/platform` 只认 platform token，staff 拿着它什么也打不开。允许勾选的后果
 *    不是漏洞而是**误导**——角色配置页上会出现一堆看起来很危险、实际什么也不做的项。
 * 3. **不许通配**。`['goods:*']` 会在新增权限点时**静默放宽**：明天加一个
 *    `goods:delete`，这个角色后天就能删商品了。想要全量只有一条路——店主
 *    （`Staff.isOwner`），而那不是角色。
 *
 * ## 内置角色（`builtin`）的保护范围
 *
 * 不可删、不可改 `code`；`name` 与 `permissionCodes` **可以改**。
 * 理由：`code` 是 `@taizan/provision` 建店时按模板写死的锚点（转让店主降级要按
 * `manager` / `staff` 去找），改了它建店逻辑就找不到人了；而「店长这个角色能干什么」
 * 本来就该由每家店自己调。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode, normalizePage, type PageResult } from '@taizan/contracts'
import { BizException } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'
import { PermissionRegistry, PERMISSION_REGISTRY, RolePermissionsService } from '@taizan/nest-rbac'
import type { Prisma, Role } from '@prisma/client'

import { autoTenantData } from '../../../common/prisma.types'
import type { AppPrismaService } from '../../../common/prisma.types'
import type { CreateRoleDto, ListRoleQueryDto, UpdateRoleDto } from './dto/role.dto'

/** 下发给前端的角色行。 */
export interface RoleView {
  id: string
  code: string
  name: string
  builtin: boolean
  permissionCodes: string[]
  /** 当前有几个在职/停用员工挂着它。前端据它决定「删除」按钮画不画。 */
  staffCount: number
  createdAt: string
  updatedAt: string
}

/** 权限点目录里的一组（按 `PermissionDef.module` 分组）。 */
export interface PermissionCatalogGroup {
  module: string
  items: { code: string; name: string; type: string }[]
}

/**
 * 平台侧权限点的 code 前缀。
 *
 * 与 `modules/platform/platform.permissions.ts` 里那批 code 的写法绑定
 * （`platform-admin:list`、`platform-tenant:list`…）。它们和商家侧共用一张注册表，
 * 所以商家侧的每一处「列出可勾选的权限点」都要按这个前缀滤掉。
 */
const PLATFORM_CODE_PREFIX = 'platform-'

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function toView(row: Role, staffCount: number): RoleView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    builtin: row.builtin,
    permissionCodes: toStringArray(row.permissionCodes),
    staffCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

@Injectable()
export class AdminRoleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(PERMISSION_REGISTRY) private readonly permissions: PermissionRegistry,
    @Inject(RolePermissionsService) private readonly roleCache: RolePermissionsService,
  ) {}

  async list(query: ListRoleQueryDto): Promise<PageResult<RoleView>> {
    const { page, pageSize } = normalizePage(query)
    const keyword = query.keyword?.trim()
    const where: Prisma.RoleWhereInput = keyword
      ? { OR: [{ name: { contains: keyword } }, { code: { contains: keyword } }] }
      : {}

    const [rows, total] = await Promise.all([
      this.prisma.tenant.role.findMany({
        // 内置角色排前面：它们是这一页的骨架，自定义角色是增补。
        orderBy: [{ builtin: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tenant.role.count({ where }),
    ])

    const counts = await this.staffCountsByRole()
    return {
      items: rows.map((row) => toView(row, counts.get(row.id) ?? 0)),
      total,
      page,
      pageSize,
    }
  }

  /**
   * 可勾选的权限点目录，按 `module` 分组。
   *
   * 分组顺序与组内顺序都跟着注册表的**注册顺序**，不排序——那个顺序是各模块在
   * `registry/permissions.ts` 里的书写顺序，本身就是有意义的（同一个模块的读/写/删挨着）。
   * 按字典序重排会把 `staff:disable` 排到 `staff:invite` 前面，读起来反而乱。
   */
  catalog(): PermissionCatalogGroup[] {
    const groups = new Map<string, PermissionCatalogGroup>()
    for (const perm of this.permissions.all()) {
      if (perm.code.startsWith(PLATFORM_CODE_PREFIX)) continue
      const group = groups.get(perm.module) ?? { module: perm.module, items: [] }
      group.items.push({ code: perm.code, name: perm.name, type: perm.type })
      groups.set(perm.module, group)
    }
    return [...groups.values()]
  }

  /** @throws `BizException` 1040000 code 重复 / 权限点非法 */
  async create(dto: CreateRoleDto): Promise<RoleView> {
    this.assertPermissionCodes(dto.permissionCodes)
    await this.assertCodeAvailable(dto.code)

    const row = await this.prisma.tenant.role.create({
      data: autoTenantData<Prisma.RoleCreateInput>({
        code: dto.code,
        name: dto.name,
        permissionCodes: dto.permissionCodes,
        // `menuKeys` 不传 = `null` = 「菜单可见范围跟随权限码自动推导」（见 04-rbac.prisma）。
        // 显式给一份菜单清单意味着它要跟着菜单注册表一起维护，而那正是 `pruneMenus` 的活。
        // 只有 `@taizan/provision` 建店时能造 builtin 角色。商家自己建的一律不是。
        builtin: false,
      }),
    })
    return toView(row, 0)
  }

  /**
   * 改角色。
   *
   * 改完 `permissionCodes` **必须** `invalidateRoles(tenantId)`：`RolePermissionsService`
   * 有 30 秒的进程内缓存，不清的话「改了权限没生效」是这个功能上线后第一个被报的 bug。
   *
   * @throws `BizException` 1240300 角色不属于本店；1040000 改内置角色的 code / 权限点非法 / code 重复
   */
  async update(id: string, dto: UpdateRoleDto): Promise<RoleView> {
    const current = await this.requireRole(id)

    if (dto.permissionCodes !== undefined) {
      this.assertPermissionCodes(dto.permissionCodes)
    }
    if (dto.code !== undefined && dto.code !== current.code) {
      if (current.builtin) {
        throw new BizException(
          ErrorCode.BAD_REQUEST,
          '内置角色的 code 不能改——建店流程按 code 找它（例如转让店主时把原店主降为 manager）',
        )
      }
      await this.assertCodeAvailable(dto.code)
    }

    const row = await this.prisma.tenant.role.update({
      where: { id },
      data: {
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.permissionCodes !== undefined ? { permissionCodes: dto.permissionCodes } : {}),
      },
    })

    const tenantId = row.tenantId
    this.roleCache.invalidateRoles(tenantId)

    const counts = await this.staffCountsByRole()
    return toView(row, counts.get(row.id) ?? 0)
  }

  /**
   * 删角色（软删）。
   *
   * 两道闸：内置的不能删；**还有人挂着的不能删**。后者不是洁癖——`Staff.roleIds` 里
   * 留着一个已删角色的 id 时，`RolePermissionsService.rolesOf` 会把它当成「查不到 =
   * 没有权限」静默跳过。也就是说那个员工会**悄悄少一批权限**，而后台上他的角色栏
   * 还显示着东西（角色名查不到，显示成空）。先让人去改人，再来删角色。
   *
   * @throws `BizException` 1040000 内置角色 / 仍被引用；1240300 角色不属于本店
   */
  async remove(id: string): Promise<{ id: string }> {
    const current = await this.requireRole(id)
    if (current.builtin) {
      throw new BizException(ErrorCode.BAD_REQUEST, '内置角色不能删除')
    }

    const counts = await this.staffCountsByRole()
    const used = counts.get(id) ?? 0
    if (used > 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `还有 ${used} 名员工挂着这个角色，请先把他们改到别的角色上再删`,
      )
    }

    await this.prisma.tenant.role.delete({ where: { id } })
    this.roleCache.invalidateRoles(current.tenantId)
    return { id }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /**
   * 统计每个角色被多少员工引用。
   *
   * `Staff.roleIds` 是 Json 数组列，MySQL 上按数组元素过滤要用 `array_contains`，
   * 而那个写法在 Prisma 的类型上很脆（`Json` 过滤器的 TS 类型随版本变）。
   * 这里改成把本店的 `roleIds` 全读出来在内存里数——**一家店的员工数是有配额上限的**
   * （`QuotaKind.STAFF`），几百行的读取换一个稳定的写法，值得。
   */
  private async staffCountsByRole(): Promise<Map<string, number>> {
    const rows = await this.prisma.tenant.staff.findMany({ select: { roleIds: true } })
    const counts = new Map<string, number>()
    for (const row of rows) {
      for (const roleId of toStringArray(row.roleIds)) {
        counts.set(roleId, (counts.get(roleId) ?? 0) + 1)
      }
    }
    return counts
  }

  /** 权限点 code 三连判：非空、已注册、不是平台侧、不含通配。 */
  private assertPermissionCodes(codes: readonly string[]): void {
    const bad: string[] = []
    const platform: string[] = []
    const wildcard: string[] = []

    for (const raw of codes) {
      const code = raw.trim()
      if (code.includes('*')) {
        wildcard.push(code)
        continue
      }
      if (code.startsWith(PLATFORM_CODE_PREFIX)) {
        platform.push(code)
        continue
      }
      if (!this.permissions.has(code)) bad.push(code)
    }

    if (wildcard.length > 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `不接受通配权限：${wildcard.join(', ')}。通配会在新增权限点时静默放宽这个角色，` +
          '要全量权限只有「店主」一条路，而店主不是角色。',
      )
    }
    if (platform.length > 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `不能给商家角色配平台侧权限点：${platform.join(', ')}。` +
          '它们只对 platform token 生效，配上去什么也不会发生，只会误导配置的人。',
      )
    }
    if (bad.length > 0) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `这些权限点没有注册过：${bad.join(', ')}。请从 GET /api/admin/roles/permissions 里选。`,
      )
    }
  }

  private async assertCodeAvailable(code: string): Promise<void> {
    const existing = await this.prisma.tenant.role.findFirst({
      where: { code },
      select: { id: true },
    })
    if (existing) {
      throw new BizException(ErrorCode.BAD_REQUEST, `已经有一个 code 为「${code}」的角色了`)
    }
  }

  /** 同 `GoodsService.requireOwned`：不区分「不存在」与「是别人家的」。 */
  private async requireRole(id: string): Promise<Role> {
    const row = await this.prisma.tenant.role.findFirst({ where: { id } })
    if (!row) {
      throw new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN, '角色不存在，或不属于当前店铺')
    }
    return row
  }
}
