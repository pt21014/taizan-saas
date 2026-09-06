/**
 * `taizan-rbac-sync` 的实现（命令入口是 `sync/cli.ts`，那里只有一行）。
 *
 * ## 为什么包里不连库
 *
 * 本包不知道你的 `PrismaClient` 从哪来（`prisma generate` 的产物在 `apps/api`，
 * 而且可能套了自定义扩展），也不该知道你的 `DATABASE_URL` 怎么读。
 * 所以命令**必须**通过 `--adapter <模块>` 拿到一个由应用侧提供的
 * {@link RbacSyncAdapter}：连库、装配注册表、用完关连接，全在应用那一侧。
 *
 * 应用侧的 adapter 长这样（`apps/api/src/rbac/sync-adapter.ts`）：
 *
 * ```ts
 * import { PrismaClient } from '@prisma/client'
 * import { PERMISSIONS } from './registry/permissions'
 * import { MENUS } from './registry/menus'
 *
 * export default async function createContext() {
 *   const prisma = new PrismaClient()
 *   return {
 *     prisma: { raw: prisma },
 *     permissions: [PERMISSIONS],
 *     menus: [MENUS],
 *     close: () => prisma.$disconnect(),
 *   }
 * }
 * ```
 *
 * 然后 `pnpm taizan-rbac-sync --adapter ./dist/rbac/sync-adapter.js`。
 *
 * @packageDocumentation
 */

import type { MenuDef } from '@taizan/contracts'
import { MenuRegistry, PermissionRegistry, type PermissionTable } from '../registry'
import { RbacSyncService, type RbacSyncPrisma, type SyncReport } from './sync.service'

/** adapter 返回的上下文。 */
export interface RbacSyncContext {
  /** 已连库的客户端，只需要一个 `raw` 句柄。 */
  prisma: RbacSyncPrisma
  /** 权限点表（多个模块的 `definePermissions()` 结果），或一张已装好的注册表。 */
  permissions: readonly PermissionTable[] | PermissionRegistry
  /** 菜单批次（多个模块的 `defineMenus()` 结果），或一张已装好的注册表。 */
  menus: readonly (readonly MenuDef[])[] | MenuRegistry
  /** 收尾（断开连接）。命令结束时一定会调，抛错也会调。 */
  close?: () => Promise<void> | void
}

/** adapter 模块的默认导出（或具名导出 `createRbacSyncContext`）。 */
export type RbacSyncAdapter = () => RbacSyncContext | Promise<RbacSyncContext>

/** 解析后的命令行参数。 */
export interface CliArgs {
  adapter?: string
  dryRun: boolean
  permissionsOnly: boolean
  menusOnly: boolean
  maxDeleteRatio?: number
  help: boolean
}

/** 命令依赖（测试从这里注入替身，不真的 import 一个文件、不真的打印）。 */
export interface CliDeps {
  /** 动态 import。默认 `(spec) => import(spec)`。 */
  importModule?: (spec: string) => Promise<unknown>
  /** 输出。默认 `console.log`。 */
  log?: (message: string) => void
  /** 错误输出。默认 `console.error`。 */
  error?: (message: string) => void
}

const USAGE = `taizan-rbac-sync — 把代码里的权限点/菜单注册表镜像进 DB

用法：
  taizan-rbac-sync --adapter <模块路径> [选项]

选项：
  --adapter <模块>        必填。默认导出（或具名导出 createRbacSyncContext）一个
                          返回 { prisma, permissions, menus, close? } 的函数
  --dry-run               只算不写，打印将要执行的变更
  --permissions-only      只同步 Permission 表
  --menus-only            只同步 Menu 表
  --max-delete-ratio <n>  删除行数占比的熔断阈值，默认 0.5，传 1 关掉
  --help                  打印这段话`

/** 解析 `process.argv.slice(2)`。 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { dryRun: false, permissionsOnly: false, menusOnly: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    switch (token) {
      case '--adapter':
        i += 1
        args.adapter = argv[i]
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--permissions-only':
        args.permissionsOnly = true
        break
      case '--menus-only':
        args.menusOnly = true
        break
      case '--max-delete-ratio':
        i += 1
        args.maxDeleteRatio = Number(argv[i])
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`[@taizan/nest-rbac] 未知参数 "${String(token)}"，用 --help 看用法`)
    }
  }
  return args
}

function toPermissionRegistry(input: RbacSyncContext['permissions']): PermissionRegistry {
  return input instanceof PermissionRegistry ? input : new PermissionRegistry(input)
}

function toMenuRegistry(
  input: RbacSyncContext['menus'],
  permissions: PermissionRegistry,
): MenuRegistry {
  return input instanceof MenuRegistry ? input : new MenuRegistry(permissions, input)
}

function pickAdapter(module: unknown): RbacSyncAdapter {
  const mod = module as Record<string, unknown> | null
  const candidate = mod?.['default'] ?? mod?.['createRbacSyncContext']
  if (typeof candidate !== 'function') {
    throw new Error(
      '[@taizan/nest-rbac] --adapter 指向的模块必须默认导出（或具名导出 createRbacSyncContext）' +
        '一个返回 { prisma, permissions, menus } 的函数',
    )
  }
  return candidate as RbacSyncAdapter
}

function describe(label: string, report: SyncReport): string {
  const prefix = report.dryRun ? '[dry-run] ' : ''
  const deleted =
    report.deleted === 0
      ? '无多余行'
      : `删除 ${report.deleted} 行（${report.deletedKeys.join(', ')}）`
  return `${prefix}${label}：写入 ${report.upserted} 行，${deleted}`
}

/**
 * 跑一次同步命令。
 *
 * @returns 进程退出码（`0` 成功，`1` 失败，`2` 参数不对）
 */
export async function runSyncCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string): void => console.log(m))
  const error = deps.error ?? ((m: string): void => console.error(m))
  const importModule = deps.importModule ?? ((spec: string): Promise<unknown> => import(spec))

  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    error((err as Error).message)
    return 2
  }

  if (args.help) {
    log(USAGE)
    return 0
  }
  if (args.adapter === undefined || args.adapter.length === 0) {
    error(`缺少 --adapter。\n\n${USAGE}`)
    return 2
  }
  if (args.permissionsOnly && args.menusOnly) {
    error('--permissions-only 与 --menus-only 互斥')
    return 2
  }

  let context: RbacSyncContext | undefined
  try {
    const adapter = pickAdapter(await importModule(args.adapter))
    context = await adapter()

    const permissions = toPermissionRegistry(context.permissions)
    const menus = toMenuRegistry(context.menus, permissions)
    const service = new RbacSyncService(context.prisma, permissions, menus)
    const options = {
      dryRun: args.dryRun,
      ...(args.maxDeleteRatio === undefined ? {} : { maxDeleteRatio: args.maxDeleteRatio }),
    }

    if (!args.menusOnly) {
      log(describe('Permission', await service.syncPermissionsToDb(options)))
    }
    if (!args.permissionsOnly) {
      log(describe('Menu', await service.syncMenusToDb(options)))
    }
    return 0
  } catch (err) {
    error(`[taizan-rbac-sync] 失败：${(err as Error).message}`)
    return 1
  } finally {
    // 连接一定要断，否则 CLI 会挂在那里不退出——这类「命令跑完了但进程不结束」
    // 的问题在 CI 上表现为超时，排查成本远高于这三行。
    await context?.close?.()
  }
}
