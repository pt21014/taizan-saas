/**
 * spec 6（`permission-registry.spec.ts`）的扫描器（蓝图 §8）。
 *
 * ## 它守的是什么
 *
 * **双向**对账：
 *
 * 1. 源码里每个 `@RequirePermission('x')` 的 `x` 必须在注册表里。漏掉的后果是
 *    那条路由永远 403——而且没有任何报错，只有商家会来说「这个按钮点了没反应」。
 * 2. 注册表里每个 `API` 类权限点必须至少被一个路由或菜单引用。没人引用的权限点是
 *    **死权限**：它会出现在角色配置页里，运营勾上它以为开了什么，实际什么也没开。
 *
 * ## 为什么是正则而不是 TS AST
 *
 * 与 `@taizan/nest-auth` 的 `default-deny.scan.ts` 同一个取舍：装饰器形状固定，
 * 正则够用；引 `typescript` 的 compiler API 会给一个架构测试加上几十兆依赖并显著变慢。
 * 代价是极端写法会漏，所以带一个**哨兵**（{@link SENTINEL_SOURCE}）：正则一旦失效，
 * 哨兵先炸，而不是让真实代码「一条都没扫到」地假通过——「扫不到」和「没问题」
 * 在断言上长得一模一样，这是静态扫描最容易骗过自己的地方。
 *
 * ## 给 apps/api 用
 *
 * ```ts
 * // apps/api/test/arch/permission-registry.spec.ts
 * import { crossCheckPermissions, readSourceFiles, scanRequirePermissionUsages } from '@taizan/nest-rbac'
 *
 * const usages = scanRequirePermissionUsages('src/**\/*.ts')
 * const report = crossCheckPermissions(usages, PERMISSIONS, { menus: MENUS })
 * expect(report.violations).toEqual([])
 * ```
 *
 * @packageDocumentation
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { MenuDef, PermissionDef } from '@taizan/contracts'
import { collectExprCodes } from '@taizan/rbac-core'

/** 一份源码。 */
export interface SourceFile {
  path: string
  source: string
}

/** 一处 `@RequirePermission(...)` 的使用。 */
export interface RequirePermissionUsage {
  /** 源文件路径。 */
  file: string
  /** 1 起算的行号。 */
  line: number
  /** 装饰器实参原文（去掉最外层括号）。 */
  raw: string
  /** 从表达式里解析出的全部 code。 */
  codes: string[]
}

/**
 * 扫描输入：一个 glob 字符串、若干 glob 字符串，或已经读好的源码列表。
 *
 * glob 只支持最常用的一种形状：`<目录>/**\/*.<扩展名>`（`**` 与 `*` 各出现一次）。
 * 复杂 glob 请自己读文件后传 {@link SourceFile}[]——把一个 glob 引擎搬进架构测试
 * 换不来任何东西。
 */
export type ScanInput = string | readonly string[] | readonly SourceFile[]

/** `@RequirePermission(...)` 的装饰器行。允许跨行实参：先抓开头，再补齐括号。 */
const DECORATOR_START = /@RequirePermission\s*\(/

/**
 * 从实参原文里抠出全部权限点 code。
 *
 * 每个字符串字面量再按 `|` 拆一次：`'goods:list|goods:write'` 是**一个**字面量但
 * 引用了**两个** code，不拆的话对账会把整串当成一个「未注册的 code」报出来，
 * 而真正的问题（其中一个拼错了）反而看不见。
 */
function stringLiterals(raw: string): string[] {
  return [...raw.matchAll(/['"`]([^'"`]*)['"`]/g)]
    .flatMap((m) => (m[1] as string).split('|'))
    .map((code) => code.trim())
    .filter((code) => code.length > 0)
}

function isSourceFileList(input: ScanInput): input is readonly SourceFile[] {
  return Array.isArray(input) && input.length > 0 && typeof input[0] === 'object'
}

/**
 * 按 `<目录>/**\/*.<扩展名>` 读一批源码。
 *
 * @param pattern - glob；不含 `*` 时当作目录，递归读 `.ts`
 */
export function readSourceFiles(pattern: string): SourceFile[] {
  const starIndex = pattern.indexOf('*')
  const root = starIndex === -1 ? pattern : pattern.slice(0, starIndex).replace(/[\\/]$/, '')
  const dotIndex = pattern.lastIndexOf('.')
  const ext = starIndex === -1 || dotIndex < starIndex ? '.ts' : pattern.slice(dotIndex)

  const out: SourceFile[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (full.endsWith(ext)) {
        out.push({ path: full.split(sep).join('/'), source: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(root)
  return out
}

function toSourceFiles(input: ScanInput): SourceFile[] {
  if (typeof input === 'string') return readSourceFiles(input)
  if (isSourceFileList(input)) return [...input]
  return (input as readonly string[]).flatMap((pattern) => readSourceFiles(pattern))
}

/**
 * 扫出源码里全部 `@RequirePermission(...)` 的使用点。
 *
 * @param input - glob、glob 列表，或已经读好的源码（{@link ScanInput}）
 */
export function scanRequirePermissionUsages(input: ScanInput): RequirePermissionUsage[] {
  const usages: RequirePermissionUsage[] = []

  for (const file of toSourceFiles(input)) {
    const lines = file.source.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string
      const match = DECORATOR_START.exec(line)
      if (match === null) continue

      // 从 `(` 开始按括号配平往后吃，最多跨 10 行——够覆盖数组形式的多行写法，
      // 又不至于在某个未闭合的括号上一路吃到文件尾。
      let depth = 0
      let raw = ''
      let consumed = false
      for (let j = i; j < Math.min(lines.length, i + 10) && !consumed; j += 1) {
        const text =
          j === i
            ? (lines[j] as string).slice(match.index + match[0].length - 1)
            : (lines[j] as string)
        for (const ch of text) {
          if (ch === '(') {
            depth += 1
            if (depth === 1) continue
          }
          if (ch === ')') {
            depth -= 1
            if (depth === 0) {
              consumed = true
              break
            }
          }
          if (depth >= 1) raw += ch
        }
        if (!consumed) raw += ' '
      }

      usages.push({ file: file.path, line: i + 1, raw: raw.trim(), codes: stringLiterals(raw) })
    }
  }
  return usages
}

/** 一条对账违规。 */
export interface PermissionDriftViolation {
  rule: 'unregistered-code' | 'dead-permission'
  code: string
  /** 给人看的中文说明（直接进断言失败信息）。 */
  message: string
  /** `unregistered-code` 才有：出现在哪里。 */
  at?: string
}

/** 双向对账的结果。 */
export interface PermissionDriftReport {
  /** 源码里引用到的全部 code（去重排序）。 */
  usedCodes: string[]
  /** 注册表里全部 code（去重排序）。 */
  registeredCodes: string[]
  violations: PermissionDriftViolation[]
}

/** {@link crossCheckPermissions} 的选项。 */
export interface CrossCheckOptions {
  /** 菜单注册表；菜单的 `permission` 也算「被引用」。 */
  menus?: readonly MenuDef[]
  /**
   * 允许存在的死权限（还没接线的功能、只给前端 `usePerm()` 用的按钮点等）。
   * 每一条都该在调用处写清楚理由——白名单没有理由就等于没有白名单。
   */
  allowUnused?: readonly string[]
  /**
   * 参与「死权限」检查的类型，默认只查 `['API']`。
   * `BUTTON` 类权限点本来就只在前端 `usePerm(code)` 里用，服务端扫不到它的引用。
   */
  checkTypes?: readonly string[]
}

function menuPermissionCodes(menus: readonly MenuDef[]): string[] {
  const out: string[] = []
  const walk = (list: readonly MenuDef[]): void => {
    for (const def of list) {
      if (def.permission !== undefined) out.push(...collectExprCodes(def.permission))
      if (def.children !== undefined) walk(def.children)
    }
  }
  walk(menus)
  return out
}

/**
 * 源码使用点 ↔ 权限点注册表的双向对账。
 *
 * @param usages - {@link scanRequirePermissionUsages} 的结果
 * @param registry - 权限点表（`definePermissions()` 的结果）或 code 列表
 * @param options - 菜单引用、白名单、参与检查的类型
 */
export function crossCheckPermissions(
  usages: readonly RequirePermissionUsage[],
  registry: Readonly<Record<string, PermissionDef>> | readonly string[],
  options: CrossCheckOptions = {},
): PermissionDriftReport {
  const isTable = !Array.isArray(registry)
  const table = isTable ? (registry as Readonly<Record<string, PermissionDef>>) : undefined
  const registeredCodes = isTable ? Object.keys(table as object) : [...(registry as string[])]
  const registered = new Set(registeredCodes)

  const allowUnused = new Set(options.allowUnused ?? [])
  const checkTypes = new Set(options.checkTypes ?? ['API'])

  const used = new Set<string>()
  const violations: PermissionDriftViolation[] = []

  for (const usage of usages) {
    for (const code of usage.codes) {
      used.add(code)
      if (!registered.has(code)) {
        violations.push({
          rule: 'unregistered-code',
          code,
          at: `${usage.file}:${usage.line}`,
          message:
            `${usage.file}:${usage.line} 的 @RequirePermission("${code}") 引用了未注册的权限点。` +
            `这条路由会永远返回 1340300，且运行时没有任何报错。请在 definePermissions() 里补上。`,
        })
      }
    }
  }

  for (const code of menuPermissionCodes(options.menus ?? [])) {
    used.add(code)
    if (!registered.has(code)) {
      violations.push({
        rule: 'unregistered-code',
        code,
        at: '菜单注册表',
        message: `菜单引用了未注册的权限点 "${code}"，该菜单会被 pruneMenus 永远裁掉。`,
      })
    }
  }

  for (const code of registeredCodes) {
    if (used.has(code) || allowUnused.has(code)) continue
    const type = table?.[code]?.type
    if (type !== undefined && !checkTypes.has(type)) continue
    violations.push({
      rule: 'dead-permission',
      code,
      message:
        `权限点 "${code}" 在注册表里，却没有任何路由或菜单引用它。` +
        `死权限会出现在角色配置页上，运营勾上它以为开了什么，实际什么也没开。` +
        `请接线、删除，或加进 allowUnused 并写明理由。`,
    })
  }

  return {
    usedCodes: [...used].sort(),
    registeredCodes: [...registered].sort(),
    violations,
  }
}

/**
 * 哨兵源码：一份**故意造出来**的、必须被扫出确定结果的输入。
 *
 * 照抄进 spec：断言 `scanRequirePermissionUsages([{ path: 'sentinel.ts', source: SENTINEL_SOURCE }])`
 * 得到 {@link SENTINEL_EXPECTATION} 描述的那些数字。正则被改坏时哨兵先炸。
 */
export const SENTINEL_SOURCE = `
@Controller('sentinel')
export class SentinelController {
  @Get('list')
  @RequirePermission('goods:list')
  list() {}

  @Post()
  @RequirePermission('goods:write|goods:list')
  create() {}

  @Put()
  @RequirePermission([
    'goods:write',
    'shop:read',
  ])
  update() {}

  @Delete()
  remove() {}
}
`

/** {@link SENTINEL_SOURCE} 必须被扫成这样。 */
export const SENTINEL_EXPECTATION = {
  /** 三个使用点（单点、或、跨行的与）。 */
  usages: 3,
  /** 去重后的 code。 */
  codes: ['goods:list', 'goods:write', 'shop:read'],
} as const
