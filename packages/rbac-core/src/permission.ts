import type { PermissionDef } from '@taizan/contracts'

/**
 * 权限点表达式求值（蓝图 §4.4）。
 *
 * 这一层只做「已授予集合 ∋ 表达式」的判定，不认识 HTTP、不认识 Nest、不读 DB；
 * `@taizan/nest-rbac` 的 `PermissionsGuard` 负责把请求上下文里的角色展开成
 * {@link expandRoles} 的输入，再把 `@RequirePermission(...)` 的表达式交给
 * {@link evaluatePermission}。
 *
 * 两处刻意不对称的设计（错了会漏权限，改之前先看这段）：
 * 1. **通配只在角色定义里允许，在表达式里禁止**。角色里写 `'goods:*'` 是「把商品模块
 *    整块授权给这个角色」，展开时机在鉴权之前，展开结果可枚举可审计；而
 *    `@RequirePermission('goods:*')` 是「有商品模块任意一个权限就能进这个接口」，
 *    语义含糊且会随着新增权限点静默放宽，因此解析时直接抛错。
 * 2. **表达式求值不做通配匹配**。`granted` 是已展开的具体 code 集合，判定只用
 *    `Set.has` 精确命中，不存在「前缀也算命中」的模糊地带。
 */

/**
 * 权限表达式。
 *
 * - 字符串：`'goods:write'` 单点；`'goods:write|goods:list'` 表示**任一**满足即可（或）。
 * - 数组：`['goods:write', 'shop:read']` 表示**全部**满足（与）；数组元素本身也可以是
 *   `'a|b'` 形式，于是 `['a|b', 'c']` 表示 `(a 或 b) 且 c`。
 */
export type PermissionExpr = string | readonly string[]

/** 权限点 code 的合法格式：`module:action`，两段均为小写字母开头的 kebab-case。 */
const CODE_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/

/** 模块级通配：`goods:*`。 */
const MODULE_WILDCARD_PATTERN = /^[a-z][a-z0-9-]*:\*$/

/** 全局通配：`*`。 */
const ALL_WILDCARD = '*'

/**
 * 判断一个 code 是否是通配写法（`'*'` 或 `'goods:*'`）。
 *
 * 通配**只允许出现在角色 / 角色预设的 `permissionCodes` 里**，会在 {@link expandRoles}、
 * {@link defineRolePreset} 里展开成具体 code；出现在权限表达式里一律视为错误。
 */
export function isWildcardCode(code: string): boolean {
  return code === ALL_WILDCARD || MODULE_WILDCARD_PATTERN.test(code)
}

/**
 * 校验并归一化一个权限点 code。
 *
 * @param code - 待校验的 code，允许带首尾空白（会被 trim 掉）
 * @returns trim 之后的 code
 * @throws 当 code 为空、含通配（`'*'` / `'goods:*'`）、或不满足 `module:action` 格式时抛出
 */
export function normalizeCode(code: string): string {
  const trimmed = typeof code === 'string' ? code.trim() : ''
  if (trimmed.length === 0) {
    throw new Error('[@taizan/rbac-core] 权限点 code 不能为空')
  }
  if (isWildcardCode(trimmed)) {
    throw new Error(
      `[@taizan/rbac-core] 权限点 code "${trimmed}" 含通配符：通配只能写在角色的 permissionCodes 里，不能出现在权限表达式中`,
    )
  }
  if (!CODE_PATTERN.test(trimmed)) {
    throw new Error(
      `[@taizan/rbac-core] 权限点 code "${trimmed}" 不符合 "module:action" 格式（如 'goods:list'）`,
    )
  }
  return trimmed
}

/**
 * 把权限表达式解析成「与之或」的二维数组：外层是与（全部满足），内层是或（任一满足）。
 *
 * `['a|b', 'c']` → `[['a', 'b'], ['c']]`。
 *
 * @throws 表达式为空数组、空串、含空的 `|` 分片、或任一 code 非法 / 含通配时抛出。
 *   刻意不把「空表达式」当成「不需要权限」——那会让一次手滑变成一个没有守卫的接口。
 */
export function parsePermissionExpr(expr: PermissionExpr): string[][] {
  const clauses = typeof expr === 'string' ? [expr] : [...expr]
  if (clauses.length === 0) {
    throw new Error('[@taizan/rbac-core] 权限表达式不能是空数组（空表达式不等于「不需要权限」）')
  }
  return clauses.map((clause) => {
    const alternatives = clause.split('|').map((part) => part.trim())
    if (alternatives.some((part) => part.length === 0)) {
      throw new Error(`[@taizan/rbac-core] 权限表达式 "${clause}" 里有空的 "|" 分片`)
    }
    return alternatives.map((part) => normalizeCode(part))
  })
}

/**
 * 求值一个权限表达式。
 *
 * @param expr - 权限表达式，语义见 {@link PermissionExpr}
 * @param granted - 已展开的权限点集合（通常来自 {@link expandRoles}），精确匹配、不做通配
 * @returns 是否通过
 * @throws 表达式本身非法时抛出（**不是**返回 false：非法表达式是代码 bug，要在测试期炸出来）
 *
 * @example
 * ```ts
 * const granted = new Set(['goods:list'])
 * evaluatePermission('goods:list|goods:write', granted) // true（或）
 * evaluatePermission(['goods:list', 'goods:write'], granted) // false（与）
 * ```
 */
export function evaluatePermission(expr: PermissionExpr, granted: ReadonlySet<string>): boolean {
  return parsePermissionExpr(expr).every((alternatives) =>
    alternatives.some((code) => granted.has(code)),
  )
}

/**
 * 收集一个权限表达式里引用到的全部权限点 code（去重，保持出现顺序）。
 *
 * 给架构约束 spec 6（`permission-registry.spec.ts`：源码里每个 `@RequirePermission('x')`
 * 的 `x` 必须在注册表里）复用，避免各处重复实现表达式解析。
 */
export function collectExprCodes(expr: PermissionExpr): string[] {
  const collected = new Set<string>()
  for (const alternatives of parsePermissionExpr(expr)) {
    for (const code of alternatives) {
      collected.add(code)
    }
  }
  return [...collected]
}

/** 取出一张 `definePermissions()` 权限点表里的全部 code，可直接喂给下面的 `allCodes`。 */
export function permissionCodesOf(table: Readonly<Record<string, PermissionDef>>): string[] {
  return Object.keys(table)
}

/** {@link expandRoles} 的入参形状：只要求有 `permissionCodes`，DB 里的 `Role` 行可直接传。 */
export interface RolePermissionSource {
  permissionCodes: string[]
}

/** {@link expandRoles} 的选项。 */
export interface ExpandRolesOptions {
  /**
   * 店主标记（对应 `Staff.isOwner`）。为 `true` 时忽略 `roles`，直接返回**全部已注册权限点**，
   * 因此必须同时传 `allCodes`，否则抛错——宁可炸，也不要静默给出一个空的店主权限集。
   */
  ownerAll?: boolean
  /** 全部已注册权限点 code（来自代码注册表，不是 DB）。展开通配、过滤死权限都靠它。 */
  allCodes?: Iterable<string>
  /**
   * 严格模式，默认 `false`。
   *
   * 默认宽松：角色里出现「格式非法」或「已从注册表删掉」的 code 时静默丢弃——这类脏数据来自
   * DB 历史遗留，丢弃的方向是**少给权限**（fail closed），不该让一次登录 500。写入侧
   * （{@link defineRolePreset}、角色编辑 DTO）才是该严格拦截的地方；`strict: true`
   * 供注册表同步命令与单测使用。
   */
  strict?: boolean
}

function matchWildcard(pattern: string, allCodes: ReadonlySet<string>): string[] {
  if (pattern === ALL_WILDCARD) {
    return [...allCodes]
  }
  const prefix = pattern.slice(0, -1) // 'goods:*' -> 'goods:'
  return [...allCodes].filter((code) => code.startsWith(prefix))
}

/**
 * 把多个角色合并展开成一个已授予权限点集合。
 *
 * 规则：
 * - 多角色取**并集**（角色之间只加不减，没有「拒绝」型角色）；
 * - 角色里的通配 `'goods:*'` / `'*'` 按 `allCodes` 展开；没传 `allCodes` 时抛错，
 *   因为那是调用方忘了传注册表（代码 bug），不是数据问题；
 * - `opts.ownerAll` 为 `true` 时结果恒等于 `allCodes` 全集，店主不受角色配置限制。
 *
 * @returns 一个只读集合，可直接传给 {@link evaluatePermission} 与 `pruneMenus`
 * @throws `ownerAll` 或通配缺 `allCodes` 时抛出；`strict: true` 且出现非法 / 未注册 code 时抛出
 *
 * @example
 * ```ts
 * const all = permissionCodesOf(PERMISSIONS)
 * expandRoles([{ permissionCodes: ['goods:*'] }], { allCodes: all })
 * expandRoles([], { ownerAll: true, allCodes: all }) // 店主 = 全部权限点
 * ```
 */
export function expandRoles(
  roles: readonly RolePermissionSource[],
  opts: ExpandRolesOptions = {},
): ReadonlySet<string> {
  const allCodes = opts.allCodes === undefined ? null : new Set<string>(opts.allCodes)

  if (opts.ownerAll === true) {
    if (allCodes === null) {
      throw new Error(
        '[@taizan/rbac-core] ownerAll 展开需要传 allCodes（店主等于全部已注册权限点，缺注册表无法展开）',
      )
    }
    return new Set(allCodes)
  }

  const granted = new Set<string>()
  for (const role of roles) {
    const codes = Array.isArray(role.permissionCodes) ? role.permissionCodes : []
    for (const raw of codes) {
      const code = typeof raw === 'string' ? raw.trim() : ''
      if (code.length === 0) {
        if (opts.strict === true) {
          throw new Error('[@taizan/rbac-core] 角色 permissionCodes 里出现空 code')
        }
        continue
      }

      if (isWildcardCode(code)) {
        if (allCodes === null) {
          throw new Error(`[@taizan/rbac-core] 角色里的通配权限 "${code}" 需要传 allCodes 才能展开`)
        }
        const matched = matchWildcard(code, allCodes)
        if (matched.length === 0 && opts.strict === true) {
          throw new Error(`[@taizan/rbac-core] 通配权限 "${code}" 没有匹配到任何已注册权限点`)
        }
        for (const item of matched) {
          granted.add(item)
        }
        continue
      }

      let normalized: string
      try {
        normalized = normalizeCode(code)
      } catch (err) {
        if (opts.strict === true) {
          throw err
        }
        continue
      }

      if (allCodes !== null && !allCodes.has(normalized)) {
        if (opts.strict === true) {
          throw new Error(`[@taizan/rbac-core] 权限点 "${normalized}" 不在已注册权限点里`)
        }
        continue
      }
      granted.add(normalized)
    }
  }
  return granted
}
