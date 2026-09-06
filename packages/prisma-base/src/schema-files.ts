/**
 * 框架 schema 片段的清单与定位。
 *
 * 片段顺序即文件名顺序：Prisma 的目录形态 schema 会把目录下所有 `.prisma` 拼起来，
 * 顺序对语义没影响，但 `00-` 前缀让「generator/datasource 只有一处」这件事一眼可见。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 8 个业务片段 + 1 个 datasource 片段，按同步到目标项目时的文件名排序。 */
export const BASE_SCHEMA_FILES = [
  '00-datasource.prisma',
  '01-tenant.prisma',
  '02-plan.prisma',
  '03-identity.prisma',
  '04-rbac.prisma',
  '05-audit.prisma',
  '06-ops.prisma',
  '07-infra.prisma',
  '08-notify.prisma',
] as const

/** 同步到业务项目后，框架片段落在 `<prisma/schema>/00-base/` 里。 */
export const BASE_SCHEMA_DIR_NAME = '00-base'

/** lock 文件名。业务项目的 `base-schema-integrity.spec.ts`（蓝图 spec 15）读它。 */
export const BASE_LOCK_FILE_NAME = 'base.lock.json'

/**
 * 每个框架片段的文件头都必须带这行，业务项目 review diff 时一眼能看出「这文件不归我改」。
 */
export const MANAGED_FILE_BANNER =
  '本文件由 @taizan/prisma-base 托管，勿手改；升级请 pnpm taizan:schema-sync'

/**
 * 从任意起点向上找到 `@taizan/prisma-base` 的包根目录。
 *
 * 用「向上找 package.json 且 name 对得上」而不是相对路径拼接：`dist/cli/sync.js`
 * 与 `src/cli/sync.ts` 的层级不一样，写死 `../..` 在其中一种形态下必错。
 *
 * @param startDir - 起点目录（通常是 CLI 脚本自身所在目录）
 * @returns 包根目录绝对路径；一路找到文件系统根都没找到时返回 `undefined`
 */
export function findPackageRoot(startDir: string): string | undefined {
  let current = resolve(startDir)
  for (;;) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { name?: unknown }).name === '@taizan/prisma-base'
        ) {
          return current
        }
      } catch {
        // package.json 读坏了就当没找到，继续往上走。
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * 定位本包的 `schema/` 目录。
 *
 * @param startDir - 起点目录，默认取当前 CLI 脚本所在目录
 * @returns `schema/` 的绝对路径
 * @throws {@link Error} 找不到包根目录时
 */
export function resolveBaseSchemaDir(startDir: string): string {
  const root = findPackageRoot(startDir)
  if (root === undefined) {
    throw new Error(
      `找不到 @taizan/prisma-base 的包根目录（从 ${startDir} 向上找 package.json 未命中）。` +
        `请用 --from=<schema 目录> 显式指定框架片段所在目录。`,
    )
  }
  return join(root, 'schema')
}
