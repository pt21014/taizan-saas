/**
 * 注册表 → DB 的单向镜像同步。
 *
 * ## 方向是定死的
 *
 * `04-rbac.prisma` 的文件头写着：「Permission / Menu 由启动期的同步任务按代码注册表
 * 覆盖写，人工在 DB 里改会在下次启动被覆盖；也因此它们不做软删」。这两张表存在的
 * 唯一理由是**让后台的角色配置页能 join 出中文名、能按模块分组勾选**——真源在代码里。
 *
 * ## 多余行：删除（不是标记）
 *
 * 二选一的决定与理由：
 *
 * - **选「删除」**。schema 注释已经明确「同步任务直接删多余行」，两张表也确实没有
 *   `deletedAt` 列；加一个 `disabled` 标记列意味着改框架 schema（要动 `base.lock.json`，
 *   见 spec 15），而收益只是「留一份谁都不会去看的历史」。
 * - **删行不会导致越权**：`Role.permissionCodes` 里可能残留已删的 code，
 *   `expandRoles` 的默认宽松模式会**静默丢弃**未注册 code（少给权限，fail closed），
 *   所以删 `Permission` 行的后果是「那个权限点从此不生效」，正是删掉它想要的效果。
 * - **风险与兜底**：真正危险的是「注册表被误清空后同步一次，把全表删了」。
 *   {@link SyncOptions.maxDeleteRatio} 就是为此存在的熔断——一次同步要删掉超过一半的
 *   现有行时直接抛错，逼人先看一眼。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import type { MenuDef } from '@taizan/contracts'
import { modelDelegateOf, PrismaService, type ModelDelegate } from '@taizan/nest-prisma'
import { MenuRegistry, PermissionRegistry } from '../registry'
import { MENU_REGISTRY, PERMISSION_REGISTRY } from '../tokens'
import { mirrorId } from './mirror-id'

/**
 * 同步命令需要的最小 Prisma 形状。
 *
 * 只要求一个 `raw` 句柄，这样 CLI 可以直接把 `new PrismaClient()` 包一层传进来，
 * 不必在包里装配整个 Nest 容器。
 */
export interface RbacSyncPrisma {
  /** 无租户注入的句柄。 */
  raw: object
}

/** {@link RbacSyncService} 的选项。 */
export interface SyncOptions {
  /**
   * 熔断阈值：一次同步要删掉的行数 / 现有行数 超过它就抛错，默认 `0.5`。
   *
   * 防的是「注册表因为一次错误的重构变空了，同步命令忠实地把线上权限表清空」。
   * 传 `1` 关掉熔断（首次初始化一张空表时用不到，因为分母是 0）。
   */
  maxDeleteRatio?: number
  /** 只算不写，打印计划。 */
  dryRun?: boolean
}

/** 一次同步的结果。 */
export interface SyncReport {
  /** 写入（upsert）的行数。 */
  upserted: number
  /** 删除的多余行数。 */
  deleted: number
  /** 被删掉的业务 key（权限点 code / 菜单 key），便于 CLI 打印与 CI 断言。 */
  deletedKeys: string[]
  /** 是否只算不写。 */
  dryRun: boolean
}

/** 写进 `Permission` 表的一行。 */
export interface PermissionRow {
  id: string
  code: string
  module: string
  name: string
  type: string
  sort: number
}

/** 写进 `Menu` 表的一行。 */
export interface MenuRow {
  id: string
  key: string
  parentKey: string | null
  title: string
  icon: string | null
  path: string | null
  componentKey: string | null
  type: string
  permission: string | null
  featureKey: string | null
  sort: number
  side: string
}

/** 把注册表里的权限点摊成待写的行（纯函数，供 CLI 的 `--dry-run` 与单测复用）。 */
export function buildPermissionRows(registry: PermissionRegistry): PermissionRow[] {
  return registry.all().map((def, index) => ({
    id: mirrorId('Permission', def.code),
    code: def.code,
    module: def.module,
    name: def.name,
    type: def.type,
    // 注册表里没有 sort 字段，用注册顺序当排序：代码里的书写顺序就是运营看到的顺序，
    // 这比让每个人手填一个不重复的数字靠谱。
    sort: index,
  }))
}

function menuRow(def: MenuDef, parentKey: string | undefined, index: number): MenuRow {
  return {
    id: mirrorId('Menu', def.key),
    key: def.key,
    parentKey: parentKey ?? null,
    title: def.title,
    icon: def.icon ?? null,
    path: def.path ?? null,
    componentKey: def.componentKey ?? null,
    type: def.type,
    permission: def.permission ?? null,
    featureKey: def.featureKey ?? null,
    sort: def.sort ?? index,
    side: def.side,
  }
}

/** 把注册表里的菜单树摊平成待写的行（先序遍历，`parentKey` 按 key 串）。 */
export function buildMenuRows(registry: MenuRegistry): MenuRow[] {
  return registry.flatten().map((item, index) => menuRow(item.def, item.parentKey, index))
}

@Injectable()
export class RbacSyncService {
  private readonly maxDeleteRatio: number
  private readonly dryRun: boolean

  constructor(
    @Inject(PrismaService) private readonly prisma: RbacSyncPrisma,
    @Inject(PERMISSION_REGISTRY) private readonly permissions: PermissionRegistry,
    @Inject(MENU_REGISTRY) private readonly menus: MenuRegistry,
    options: SyncOptions = {},
  ) {
    this.maxDeleteRatio = options.maxDeleteRatio ?? 0.5
    this.dryRun = options.dryRun ?? false
  }

  /**
   * 把权限点注册表镜像进 `Permission` 表。
   *
   * 幂等：同一份注册表跑两次，发出去的 `upsert` 参数**逐字节相同**（主键由
   * {@link mirrorId} 确定性生成），第二次不会产生任何实际变更。
   */
  async syncPermissionsToDb(options: SyncOptions = {}): Promise<SyncReport> {
    const rows = buildPermissionRows(this.permissions)
    return this.mirror(this.delegate('permission'), rows, 'code', options)
  }

  /**
   * 把菜单注册表镜像进 `Menu` 表。
   *
   * 父子关系按 `key` 串（不是 id）——注册表里写的就是 key，用 id 串意味着同步命令
   * 要先插父再插子并回读 id，一次网络往返换来的只是一个「更规范」的外键。
   */
  async syncMenusToDb(options: SyncOptions = {}): Promise<SyncReport> {
    const rows = buildMenuRows(this.menus)
    return this.mirror(this.delegate('menu'), rows, 'key', options)
  }

  /** 两张表一起同步（启动期 / CLI 默认行为）。 */
  async syncAll(options: SyncOptions = {}): Promise<{
    permissions: SyncReport
    menus: SyncReport
  }> {
    return {
      permissions: await this.syncPermissionsToDb(options),
      menus: await this.syncMenusToDb(options),
    }
  }

  /**
   * `Permission` / `Menu` 都是【平台域】镜像表（没有 `tenantId` 列），必须走 `raw`。
   *
   * raw-reason: 平台域镜像表。走 `prisma.tenant` 的话租户扩展会因为「未登记的模型」
   * 抛错（或者更糟：被当成租户表注入一个不存在的列）；这两张表本来就不属于任何租户。
   */
  private delegate(clientKey: string): ModelDelegate {
    return modelDelegateOf(this.prisma.raw, clientKey)
  }

  private async mirror(
    delegate: ModelDelegate,
    rows: readonly (PermissionRow | MenuRow)[],
    uniqueField: 'code' | 'key',
    options: SyncOptions,
  ): Promise<SyncReport> {
    const dryRun = options.dryRun ?? this.dryRun
    const maxDeleteRatio = options.maxDeleteRatio ?? this.maxDeleteRatio
    const keyOf = (row: PermissionRow | MenuRow): string =>
      uniqueField === 'code' ? (row as PermissionRow).code : (row as MenuRow).key
    const keys = rows.map(keyOf)

    const existing = ((await delegate.findMany({ select: { [uniqueField]: true } })) ??
      []) as Record<string, unknown>[]
    const kept = new Set(keys)
    const deletedKeys = existing
      .map((row) => String(row[uniqueField]))
      .filter((key) => !kept.has(key))

    if (existing.length > 0 && deletedKeys.length / existing.length > maxDeleteRatio) {
      throw new Error(
        `[@taizan/nest-rbac] 本次同步要删掉 ${deletedKeys.length}/${existing.length} 行，` +
          `超过熔断阈值 ${maxDeleteRatio}。注册表是不是被误清空了？` +
          `确认无误请传 maxDeleteRatio: 1`,
      )
    }

    if (dryRun) {
      return { upserted: rows.length, deleted: deletedKeys.length, deletedKeys, dryRun: true }
    }

    for (const row of rows) {
      const { id, ...rest } = row as unknown as { id: string } & Record<string, unknown>
      await delegate.upsert({
        where: { [uniqueField]: keyOf(row) },
        // update 里刻意**不带 id**：镜像表的主键一旦发下去就不该再变，
        // 而 mirrorId 是确定性的，带上它只会在 diff 里制造噪音。
        update: rest,
        create: { id, ...rest },
      })
    }

    if (deletedKeys.length > 0) {
      await delegate.deleteMany({ where: { [uniqueField]: { in: deletedKeys } } })
    }

    return { upserted: rows.length, deleted: deletedKeys.length, deletedKeys, dryRun: false }
  }
}
