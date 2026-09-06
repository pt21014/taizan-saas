import type { MenuDef, MenuNode, MenuSide } from '@taizan/contracts'
import { evaluatePermission } from './permission'

/**
 * 菜单树裁剪（蓝图 §4.4）：把代码注册表里的 {@link MenuDef} 按
 * **权限 ∩ 套餐 features ∩ 显式禁用 ∩ 所属侧** 裁成下发给前端的 {@link MenuNode} 树。
 *
 * 这一层是纯函数：不查 DB、不认识 Nest。`@taizan/nest-rbac` 的
 * `GET /api/admin/auth/bootstrap` 负责把 `Staff` / `Role` / `Plan.features` 组装成
 * {@link PruneMenusContext} 再调用这里。
 */

/**
 * 裁剪后下发给前端的菜单节点。
 *
 * 形状 = 蓝图 §4.4 的 `MenuNode`（`key/title/icon?/path?/componentKey?/type/sort/children?`）
 * **加上一个可选的 `permission`**。这一处取舍是刻意的：
 *
 * - **保留 `permission`**：`BUTTON` 类型节点存在的唯一目的就是给前端做按钮级渲染判断，
 *   前端需要知道这颗按钮对应哪个 code 才能 `usePerm(code)`。而且能出现在结果里的节点
 *   本来就已经通过了权限判定，等于把「用户自己已经有的权限」告诉他，不泄露任何东西。
 * - **不保留 `featureKey`**：套餐功能项属于计费侧内部信息，暴露出去等于把「你没买哪些
 *   功能」的清单送给前端，且会诱导前端拿 featureKey 自己做二次判断（真源应当只有服务端）。
 * - **不保留 `side` 以及任何其它注册信息**：`side` 已经被 {@link PruneMenusContext.side}
 *   过滤掉了，下发只会制造第二份真源。
 *
 * 因为 `PrunedMenuNode extends MenuNode`，返回值可以直接赋给 `BootstrapResponse['menus']`。
 */
export interface PrunedMenuNode extends MenuNode {
  /** 该节点依赖的权限点表达式（原样透传），供前端按钮级权限判断使用 */
  permission?: string
  children?: PrunedMenuNode[]
}

/** {@link pruneMenus} 的裁剪上下文。 */
export interface PruneMenusContext {
  /** 已展开的权限点集合（来自 `expandRoles`）。带 `permission` 的节点不满足即整棵子树移除。 */
  granted: ReadonlySet<string>
  /**
   * 套餐功能开关，**三态**（与 `hasFeature` 同语义）：
   * `null` = 全部功能可用（不做 feature 裁剪）；`[]` = 一个功能都不给；
   * 非空数组 = 只给列出的这些。
   */
  features: string[] | null
  /** 显式禁用的菜单 key（平台/租户手工关掉的入口），命中即整棵子树移除。 */
  disabledKeys?: ReadonlySet<string>
  /** 当前所属侧；`side` 不等于它的节点直接移除（商家后台不会看到平台菜单，反之亦然）。 */
  side: MenuSide
}

function pruneOne(
  def: MenuDef,
  ctx: PruneMenusContext,
  features: ReadonlySet<string> | null,
): PrunedMenuNode | null {
  if (def.side !== ctx.side) {
    return null
  }
  if (ctx.disabledKeys !== undefined && ctx.disabledKeys.has(def.key)) {
    return null
  }
  if (def.permission !== undefined && !evaluatePermission(def.permission, ctx.granted)) {
    return null
  }
  if (def.featureKey !== undefined && features !== null && !features.has(def.featureKey)) {
    return null
  }

  const children =
    def.children === undefined || def.children.length === 0
      ? []
      : pruneLevel(def.children, ctx, features)

  // DIR 是纯分组：子节点被裁光之后它自己也必须消失，否则前端会渲染出一个点进去空空如也的目录。
  if (def.type === 'DIR' && children.length === 0) {
    return null
  }

  const node: PrunedMenuNode = {
    key: def.key,
    title: def.title,
    type: def.type,
    sort: def.sort ?? 0,
  }
  if (def.icon !== undefined) {
    node.icon = def.icon
  }
  if (def.path !== undefined) {
    node.path = def.path
  }
  if (def.componentKey !== undefined) {
    node.componentKey = def.componentKey
  }
  if (def.permission !== undefined) {
    node.permission = def.permission
  }
  if (children.length > 0) {
    node.children = children
  }
  return node
}

function pruneLevel(
  defs: readonly MenuDef[],
  ctx: PruneMenusContext,
  features: ReadonlySet<string> | null,
): PrunedMenuNode[] {
  const kept: { node: PrunedMenuNode; index: number }[] = []
  defs.forEach((def, index) => {
    const node = pruneOne(def, ctx, features)
    if (node !== null) {
      kept.push({ node, index })
    }
  })
  // 稳定排序：sort 相同时按注册顺序，保证同一份注册表在任何运行时都给出同一个下发结果。
  kept.sort((a, b) => a.node.sort - b.node.sort || a.index - b.index)
  return kept.map((item) => item.node)
}

/**
 * 按 权限 ∩ 套餐 features ∩ 显式禁用 ∩ 所属侧 裁剪菜单树。
 *
 * 裁剪规则（逐节点自上而下，命中任意一条即**连同整棵子树**移除）：
 * 1. `side` 与 `ctx.side` 不一致；
 * 2. `key` 命中 `ctx.disabledKeys`；
 * 3. 带 `permission` 且表达式在 `ctx.granted` 下不成立（支持 `'a|b'`，不支持通配）；
 * 4. 带 `featureKey` 且 `ctx.features` 非 `null` 且不含该 key。
 *
 * 之后再自下而上：`DIR` 的子节点被裁光之后它自己也消失（可能连锁消失多层）。
 * `BUTTON` 节点会被保留在结果里（前端按钮级权限要用），但它永远不进路由，见 {@link buildRoutes}。
 * 同级按 `sort` 升序稳定排序（`sort` 缺省视为 `0`，相同时保持注册顺序）。
 *
 * @returns 裁剪后的菜单树；结果里只含 {@link PrunedMenuNode} 列出的字段
 *
 * @example
 * ```ts
 * const menus = pruneMenus(MENUS, {
 *   granted: expandRoles(roles, { allCodes }),
 *   features: plan.features, // null = 全部可用
 *   disabledKeys: new Set(['marketing']),
 *   side: 'ADMIN',
 * })
 * ```
 */
export function pruneMenus(defs: readonly MenuDef[], ctx: PruneMenusContext): PrunedMenuNode[] {
  const features = ctx.features === null ? null : new Set(ctx.features)
  return pruneLevel(defs, ctx, features)
}

/** {@link buildRoutes} 的输出条目：前端 `registerRoutes()` 直接消费的扁平路由表。 */
export interface MenuRoute {
  key: string
  path: string
  componentKey: string
}

function collectRoutes(nodes: readonly MenuNode[], out: MenuRoute[]): void {
  for (const node of nodes) {
    // DIR 是纯分组不进路由；BUTTON 只影响按钮渲染，更不该产生页面。
    // MENU 必须同时有 path 与 componentKey 才能渲染，缺任意一个都跳过（否则前端拿到一条渲染不出来的路由）。
    if (
      node.type === 'MENU' &&
      node.path !== undefined &&
      node.path.length > 0 &&
      node.componentKey !== undefined &&
      node.componentKey.length > 0
    ) {
      out.push({ key: node.key, path: node.path, componentKey: node.componentKey })
    }
    if (node.children !== undefined && node.children.length > 0) {
      collectRoutes(node.children, out)
    }
  }
}

/**
 * 从裁剪后的菜单树里抽出可路由的扁平列表。
 *
 * 只有 `type: 'MENU'` 且同时具备 `path` 与 `componentKey` 的节点会进入结果：
 * `DIR` 没有 path 不进路由，`BUTTON` 只做按钮权限不进路由。
 * `componentKey → 组件` 的映射表在前端（`@taizan/admin-ui` 的 `registerRoutes()`），
 * 服务端只下发 key，不下发前端文件路径。
 *
 * 顺序为菜单树的先序遍历（父在子前），与 {@link pruneMenus} 的排序结果一致。
 */
export function buildRoutes(nodes: readonly MenuNode[]): MenuRoute[] {
  const routes: MenuRoute[] = []
  collectRoutes(nodes, routes)
  return routes
}

/**
 * 先序遍历菜单树，取出全部节点 key（含 `DIR` 与 `BUTTON`）。
 *
 * 用于角色配置页的「菜单勾选」回显、以及 `Role.menuKeys` 与注册表的对账。
 */
export function flattenMenuKeys(nodes: readonly MenuNode[]): string[] {
  const keys: string[] = []
  const walk = (list: readonly MenuNode[]): void => {
    for (const node of list) {
      keys.push(node.key)
      if (node.children !== undefined && node.children.length > 0) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return keys
}
