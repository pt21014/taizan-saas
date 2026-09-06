/**
 * spec 7（`menu-route-map.spec.ts`）的校验器（蓝图 §8）。
 *
 * ## 它守的是什么
 *
 * 服务端只下发 `componentKey`，`componentKey → 组件` 的映射表在前端
 * （`@taizan/admin-ui` 的 `registerRoutes()`）。这条设计避免了把前端文件路径写进数据库，
 * 代价是**两边可能漂移**：菜单里写了一个前端没有的 key，用户点进去看到的是一个白屏，
 * 控制台里一句 warn 都没有。
 *
 * 三条断言：
 * 1. 每个 `type: 'MENU'` 且有 `componentKey` 的菜单，该 key 必须在 `componentMap` 里；
 * 2. 每个带 `path` 的菜单必须同时有 `componentKey`（有路由没组件 = 白屏）；
 * 3. 每个带 `permission` 的菜单，该权限点必须存在（与 spec 6 共用一份权限点集合）。
 *
 * 反向的「componentMap 里有、菜单里没有」默认**只警告不报错**：前端留几个不挂菜单的
 * 页面（登录页、404、内嵌详情页）是完全正常的，把它做成硬失败会逼所有人往
 * 白名单里塞东西，最后白名单比菜单还长。
 *
 * @packageDocumentation
 */

import type { MenuDef } from '@taizan/contracts'
import { collectExprCodes } from '@taizan/rbac-core'

/** 一条校验失败。 */
export interface MenuMapViolation {
  rule: 'missing-component' | 'path-without-component' | 'unknown-permission'
  /** 出问题的菜单 key。 */
  menuKey: string
  /** 给人看的中文说明。 */
  message: string
}

/** 校验结果。 */
export interface MenuMapReport {
  /** 菜单里用到的全部 componentKey（去重排序）。 */
  usedComponentKeys: string[]
  /** `componentMap` 里没有被任何菜单引用的 key（只是提示，不算违规）。 */
  unusedComponentKeys: string[]
  violations: MenuMapViolation[]
}

/** {@link verifyMenuComponentMap} 的选项。 */
export interface VerifyMenuMapOptions {
  /**
   * 权限点集合（`definePermissions()` 的表，或 code 列表）。
   * 不传就跳过第 3 条断言。
   */
  permissions?: Readonly<Record<string, unknown>> | readonly string[]
  /** 允许缺映射的 componentKey（例如前端还没提交的新页面），每条都该写理由。 */
  allowMissing?: readonly string[]
}

function keySet(
  input: Readonly<Record<string, unknown>> | readonly string[] | Iterable<string>,
): Set<string> {
  if (Array.isArray(input)) return new Set(input as string[])
  if (typeof (input as Iterable<string>)[Symbol.iterator] === 'function') {
    return new Set(input as Iterable<string>)
  }
  return new Set(Object.keys(input as Record<string, unknown>))
}

/**
 * 菜单注册表 ↔ 前端 `component-map.ts` 的对账。
 *
 * @param menus - 菜单定义（整棵树，两侧都传进来即可；`side` 不影响本校验）
 * @param componentMap - 前端映射表本体（取 `Object.keys`）、key 数组，或任意可迭代的 key
 * @param options - 权限点集合与白名单
 *
 * @example
 * ```ts
 * const report = verifyMenuComponentMap(MENUS, ADMIN_COMPONENT_MAP, { permissions: PERMISSIONS })
 * expect(report.violations).toEqual([])
 * ```
 */
export function verifyMenuComponentMap(
  menus: readonly MenuDef[],
  componentMap: Readonly<Record<string, unknown>> | readonly string[] | Iterable<string>,
  options: VerifyMenuMapOptions = {},
): MenuMapReport {
  const mapped = keySet(componentMap)
  const allowMissing = new Set(options.allowMissing ?? [])
  const permissions = options.permissions === undefined ? undefined : keySet(options.permissions)

  const used = new Set<string>()
  const violations: MenuMapViolation[] = []

  const walk = (list: readonly MenuDef[]): void => {
    for (const def of list) {
      if (def.componentKey !== undefined && def.componentKey.length > 0) {
        used.add(def.componentKey)
        if (!mapped.has(def.componentKey) && !allowMissing.has(def.componentKey)) {
          violations.push({
            rule: 'missing-component',
            menuKey: def.key,
            message:
              `菜单 "${def.key}" 的 componentKey "${def.componentKey}" 在前端 component-map 里没有映射：` +
              `用户点进去会看到白屏，且控制台没有任何报错。`,
          })
        }
      } else if (def.path !== undefined && def.path.length > 0 && def.type === 'MENU') {
        violations.push({
          rule: 'path-without-component',
          menuKey: def.key,
          message: `菜单 "${def.key}" 有 path "${def.path}" 却没有 componentKey：这条路由渲染不出任何东西。`,
        })
      }

      if (permissions !== undefined && def.permission !== undefined) {
        for (const code of collectExprCodes(def.permission)) {
          if (!permissions.has(code)) {
            violations.push({
              rule: 'unknown-permission',
              menuKey: def.key,
              message:
                `菜单 "${def.key}" 引用了未注册的权限点 "${code}"：` +
                `pruneMenus 会把它永远裁掉，功能等于凭空消失。`,
            })
          }
        }
      }

      if (def.children !== undefined && def.children.length > 0) walk(def.children)
    }
  }
  walk(menus)

  return {
    usedComponentKeys: [...used].sort(),
    unusedComponentKeys: [...mapped].filter((key) => !used.has(key)).sort(),
    violations,
  }
}
