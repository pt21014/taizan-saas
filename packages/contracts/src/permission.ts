/**
 * 权限点协议（蓝图 §4.4）：权限点「代码即真源」，业务模块用 {@link definePermissions}
 * 注册自己的权限点表，`@taizan/nest-rbac` 的同步命令据此写入 DB，前端 `usePerm()` 按
 * 同名 code 判定按钮是否渲染。
 */

/** 权限点类型：`API` 挂在接口上由守卫拦截，`BUTTON` 只影响前端渲染（不单独拦截接口）。 */
export type PermissionType = 'API' | 'BUTTON'

/** 一个权限点的定义。 */
export interface PermissionDef {
  /** 所属模块的中文名，用于后台角色配置页分组展示 */
  module: string
  /** 权限点中文名 */
  name: string
  /** 权限点类型 */
  type: PermissionType
}

/** 权限点 code 的合法格式：`module:action`，两段均为小写字母开头的 kebab-case。 */
const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/

/**
 * 注册一张权限点表。
 *
 * @param defs - `code -> 定义` 的映射；`code` 必须满足 `module:action` 格式
 *   （如 `'goods:list'`、`'goods:write'`），供 `@RequirePermission('goods:write')`、
 *   `'a|b'`（或）与 `['a','b']`（与）表达式引用。
 * @returns 冻结后的权限点表（不可再变更）
 * @throws 当任一 `code` 不满足 `module:action` 格式时抛出
 *
 * @example
 * ```ts
 * export const PERMISSIONS = definePermissions({
 *   'goods:list':   { module: '商品', name: '查看商品', type: 'API' },
 *   'goods:write':  { module: '商品', name: '新增/编辑商品', type: 'API' },
 *   'goods:export': { module: '商品', name: '导出商品', type: 'BUTTON' },
 * })
 * ```
 */
export function definePermissions<const T extends Record<string, PermissionDef>>(
  defs: T,
): Readonly<T> {
  for (const code of Object.keys(defs)) {
    if (!PERMISSION_CODE_PATTERN.test(code)) {
      throw new Error(
        `[@taizan/contracts] 权限点 code "${code}" 不符合 "module:action" 格式（如 'goods:list'）`,
      )
    }
  }
  const frozenEntries = Object.entries(defs).map(([k, v]) => [k, Object.freeze({ ...v })] as const)
  return Object.freeze(Object.fromEntries(frozenEntries)) as Readonly<T>
}

/**
 * 框架自带权限点 code 的单一真源（T1-9 收口）。
 *
 * ## 为什么这份清单要放在零依赖的 `@taizan/contracts` 里
 *
 * 权限点分两层：**框架自带**（本清单：`staff:*`、`role:*`、`audit:list`、
 * `announcement:list`、`profile:*`、`billing:*`）与**业务自己注册**（如
 * `goods:*`）。`@taizan/prisma-base` 的内置角色模板（`manager` / `staff`）要给出
 * 合理默认，就必须引用框架自带的那一层——但 `prisma-base` 不能依赖 `apps/api`
 * （应用是消费包的一方，反过来会成环），而这些 code 真正的 `PermissionDef`
 * （中文名、模块分组）恰恰定义在 `apps/api` 各模块的 `*.permissions.ts` 里。
 *
 * 拆法：**只把 code 字符串**抽到这份不依赖任何人的常量里，`name` / `module` 那些
 * 展示用的元数据留在 `apps/api` 的定义原地——`prisma-base` 的角色模板只需要
 * 知道「这个 code 存在」，不需要知道它中文名叫什么。`apps/api` 的
 * `registry/permissions.ts` 反过来断言「这份清单里的每个 code 都真的注册了」，
 * 两侧对同一份清单做相反方向的校验，任何一边漏改都会在各自的测试里炸。
 *
 * ⚠️ 只在这里新增/删除**框架自带**的权限点时才改这份清单；业务权限点
 * （`goods:*` 这类）永远不进来——进来一条，`prisma-base` 就得替业务猜一份
 * 角色模板默认值，猜错比不猜更糟。
 */
export const FRAMEWORK_PERMISSION_CODES = [
  'staff:list',
  'staff:invite',
  'staff:write',
  'staff:disable',
  'staff:transfer-owner',
  'role:list',
  'role:write',
  'role:delete',
  'audit:list',
  'announcement:list',
  'profile:read',
  'profile:write',
  'billing:view',
  'billing:order',
] as const

/** {@link FRAMEWORK_PERMISSION_CODES} 里任一 code 的类型。 */
export type FrameworkPermissionCode = (typeof FRAMEWORK_PERMISSION_CODES)[number]
