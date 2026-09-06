/**
 * 菜单协议（蓝图 §4.4）：菜单「代码即真源」，业务模块用 {@link defineMenus} 注册，
 * `@taizan/nest-rbac` 按 权限 ∩ 套餐 features ∩ 显式禁用 裁剪后，通过
 * `GET /api/admin/auth/bootstrap` 下发给前端。
 *
 * 区分两种形状：{@link MenuDef} 是注册时的完整定义（含 `permission`/`featureKey` 等
 * 裁剪依据，只在服务端使用）；{@link MenuNode} 是下发给前端的裁剪结果（不含裁剪依据，
 * 前端拿不到也不需要知道某个菜单为什么被裁掉）。
 */

/** 菜单节点类型：`DIR` 纯分组（不进路由）、`MENU` 对应一个页面、`BUTTON` 仅用于按钮级权限点。 */
export type MenuType = 'DIR' | 'MENU' | 'BUTTON'

/** 菜单所属侧：商家后台 `ADMIN` 或平台超管后台 `PLATFORM`。 */
export type MenuSide = 'ADMIN' | 'PLATFORM'

/** 菜单注册定义（服务端专用，包含裁剪依据）。 */
export interface MenuDef {
  /** 全局唯一 key，前端 `componentMap` 与后端裁剪逻辑都靠它对齐 */
  key: string
  /** 菜单标题 */
  title: string
  /** 图标名（前端自行映射到具体图标组件） */
  icon?: string
  /** 路由 path；`DIR` 一般不需要（纯分组不进路由） */
  path?: string
  /** 前端组件映射 key；服务端只下发 key，不下发文件路径，避免把前端结构写进数据库 */
  componentKey?: string
  /** 菜单类型 */
  type: MenuType
  /** 所属侧 */
  side: MenuSide
  /** 依赖的权限点 code（同 `@RequirePermission`），缺省表示不受权限裁剪 */
  permission?: string
  /** 依赖的套餐功能项 key（同 `hasFeature`），缺省表示不受套餐裁剪 */
  featureKey?: string
  /** 同级排序，数值越小越靠前 */
  sort?: number
  /** 子菜单；`DIR` 必须有至少一个子节点，否则是一个「进去空空如也」的分组 */
  children?: MenuDef[]
}

/** 下发给前端的菜单节点（`GET /api/admin/auth/bootstrap` 返回的 `menus` 数组元素类型）。 */
export interface MenuNode {
  key: string
  title: string
  icon?: string
  path?: string
  componentKey?: string
  type: MenuType
  sort: number
  children?: MenuNode[]
}

function collectAndValidate(nodes: readonly MenuDef[], seenKeys: Set<string>, path: string): void {
  for (const node of nodes) {
    const nodePath = path ? `${path} > ${node.key}` : node.key
    if (seenKeys.has(node.key)) {
      throw new Error(`[@taizan/contracts] 菜单 key "${node.key}" 重复注册（路径：${nodePath}）`)
    }
    seenKeys.add(node.key)

    const hasChildren = Array.isArray(node.children) && node.children.length > 0
    if (node.type === 'DIR' && !hasChildren) {
      throw new Error(
        `[@taizan/contracts] 菜单 "${node.key}" 类型为 DIR 必须有至少一个 children（路径：${nodePath}）`,
      )
    }
    if (node.type !== 'DIR' && hasChildren) {
      throw new Error(
        `[@taizan/contracts] 菜单 "${node.key}" 类型为 ${node.type} 不应有 children（路径：${nodePath}）`,
      )
    }
    if (hasChildren) {
      collectAndValidate(node.children as MenuDef[], seenKeys, nodePath)
    }
  }
}

/**
 * 注册一张菜单表。
 *
 * 校验规则：
 * - 全树（含所有层级）`key` 必须唯一；
 * - `type: 'DIR'` 必须至少有一个 `children`（纯分组不能进去空空如也）；
 * - 非 `DIR` 类型不应携带 `children`（`MENU`/`BUTTON` 是叶子节点）。
 *
 * @returns 冻结后的菜单定义数组（不可再变更）
 *
 * @example
 * ```ts
 * export const MENUS = defineMenus([
 *   { key: 'goods', title: '商品', icon: 'ShopOutlined', type: 'DIR', side: 'ADMIN', children: [
 *     { key: 'goods.list', title: '商品列表', path: '/goods', componentKey: 'GoodsList',
 *       permission: 'goods:list', featureKey: 'goods', sort: 10, type: 'MENU', side: 'ADMIN' },
 *   ]},
 * ])
 * ```
 */
export function defineMenus<const T extends readonly MenuDef[]>(defs: T): Readonly<T> {
  collectAndValidate(defs, new Set<string>(), '')
  return Object.freeze(defs)
}
