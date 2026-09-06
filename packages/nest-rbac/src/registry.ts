/**
 * 三张注册表：权限点、菜单、套餐功能项。
 *
 * ## 为什么注册表是「真源」而 DB 是镜像
 *
 * 权限点与菜单是**代码的一部分**：`@RequirePermission('goods:write')` 引用的是一个
 * 代码里的常量，菜单的 `componentKey` 指向前端的一个组件。让 DB 当真源意味着
 * 「改一行代码要配一次库」，而且两边一旦漂移，表现是「按钮点了没反应」或者
 * 「菜单进去空白页」——两种都极难排查。所以方向定死：**代码 → DB 单向镜像**
 * （`sync/sync.service.ts`），人工在 DB 里改会在下次同步被覆盖。
 *
 * ## 三张表的职责边界
 *
 * - {@link PermissionRegistry}：合并各模块的 `definePermissions()` 结果，重复 code 抛错。
 * - {@link MenuRegistry}：合并各模块的 `defineMenus()` 结果，key 全树唯一，
 *   并**校验每个菜单引用的权限点确实存在**（蓝图 §8 spec 7 的运行时半边）。
 * - {@link FeatureRegistry}：只存不判。功能开关的判定逻辑在 `@taizan/billing-rules`
 *   （`hasFeature`/`evaluateFeatureGate`），本包不重写一行。
 *
 * @packageDocumentation
 */

import type { MenuDef, MenuSide, PermissionDef } from '@taizan/contracts'
import { collectExprCodes } from '@taizan/rbac-core'

/** 权限点表：`definePermissions()` 的返回形状。 */
export type PermissionTable = Readonly<Record<string, PermissionDef>>

/** 注册表里的一条权限点（`code` 展开进对象，便于直接喂给同步命令）。 */
export interface RegisteredPermission extends PermissionDef {
  code: string
}

/**
 * 套餐功能项定义。
 *
 * **结构上与 `@taizan/billing-rules` 的 `FeatureDef` 完全一致**，这里之所以重新声明
 * 而不是 import，是为了不让 RBAC 层反向依赖计费层：本包对功能项只做「存下来，
 * 交给 `pruneMenus` 当 `features` 用」，一行判定逻辑都没有。装配时把
 * `billing-rules` 的注册表原样传进 {@link FeatureRegistry} 即可（结构类型天然兼容）。
 */
export interface FeatureDef {
  /** 功能 key，与 `Plan.features` 里存的字符串一致。 */
  key: string
  /** 给平台运营看的名字：勾掉之后商家少了什么。 */
  name: string
  /** `true` = 只拦写操作，读照常放行；`false` = 连读一起拦。 */
  writeOnly: boolean
  /** 这个功能对应的接口路径前缀，带 `/api` 全局前缀的完整形式。 */
  pathPrefixes: string[]
}

/**
 * 权限点注册表。
 *
 * 多个业务模块各自 `definePermissions()`，装配时全部 {@link register} 进来合并成一张表。
 * **重复 code 直接抛错**：两个模块声明同一个 code 时，谁覆盖谁在语义上没有正确答案
 * （名字可能不同、type 可能一个 API 一个 BUTTON），静默取后者只会让角色配置页显示
 * 一个谁都不认识的名字。
 */
export class PermissionRegistry {
  private readonly byCode = new Map<string, RegisteredPermission>()
  /** 记住每个 code 是哪一批注册进来的，重复时的报错才指得出「和谁撞了」。 */
  private readonly origin = new Map<string, string>()

  /**
   * @param tables - 可选的初始权限点表，等价于依次 {@link register}
   */
  constructor(tables: readonly PermissionTable[] = []) {
    tables.forEach((table, index) => {
      this.register(table, `#${index}`)
    })
  }

  /**
   * 合并一张 `definePermissions()` 的结果。
   *
   * @param table - 权限点表
   * @param source - 来源标记（模块名之类），只用于报错信息
   * @throws 出现重复 code 时抛出
   */
  register(table: PermissionTable, source = '匿名注册'): this {
    for (const [code, def] of Object.entries(table)) {
      const existing = this.origin.get(code)
      if (existing !== undefined) {
        throw new Error(
          `[@taizan/nest-rbac] 权限点 code "${code}" 重复注册（${existing} 与 ${source}）：` +
            `两个模块声明同一个 code 时谁覆盖谁没有正确答案，请改名或合并到同一张表`,
        )
      }
      this.origin.set(code, source)
      this.byCode.set(code, { code, ...def })
    }
    return this
  }

  /** 全部权限点（按注册顺序）。 */
  all(): RegisteredPermission[] {
    return [...this.byCode.values()]
  }

  /** 是否注册过某个 code。 */
  has(code: string): boolean {
    return this.byCode.has(code)
  }

  /** 取一条权限点定义。 */
  get(code: string): RegisteredPermission | undefined {
    return this.byCode.get(code)
  }

  /** 全部权限点 code（按注册顺序）。可直接喂给 `expandRoles` 的 `allCodes`。 */
  codes(): string[] {
    return [...this.byCode.keys()]
  }

  /** 已注册的权限点数量。 */
  get size(): number {
    return this.byCode.size
  }
}

function walkMenus(
  defs: readonly MenuDef[],
  visit: (def: MenuDef, parentKey?: string) => void,
): void {
  const walk = (list: readonly MenuDef[], parentKey?: string): void => {
    for (const def of list) {
      visit(def, parentKey)
      if (def.children !== undefined && def.children.length > 0) {
        walk(def.children, def.key)
      }
    }
  }
  walk(defs)
}

/**
 * 菜单注册表。
 *
 * 注册时做两件 `defineMenus()` 做不到的校验（它只看得见自己那一批）：
 * 1. **跨批次的 key 唯一**；
 * 2. **每个 `permission` 引用的权限点必须已在 {@link PermissionRegistry} 里**。
 *    这条是蓝图 §8 spec 7 的运行时半边：一个引用了不存在权限点的菜单，
 *    `pruneMenus` 会把它永远裁掉，前端表现是「这个功能凭空消失了」，没有任何报错。
 *    所以在装配期就炸，而不是等商家来投诉。
 *
 * `featureKey` **不校验**：功能项注册表是计费侧的东西，允许「菜单先写好、
 * 套餐功能项晚一步上线」——那种情况下菜单只是暂时不受功能裁剪（`features=null` 时全放行），
 * 不会消失，属于安全的一侧。
 */
export class MenuRegistry {
  private readonly roots: MenuDef[] = []
  private readonly byKey = new Map<string, MenuDef>()

  /**
   * @param permissions - 权限点注册表，用于校验菜单引用的权限点存在
   * @param batches - 可选的初始菜单批次
   */
  constructor(
    private readonly permissions: PermissionRegistry,
    batches: readonly (readonly MenuDef[])[] = [],
  ) {
    batches.forEach((batch, index) => {
      this.register(batch, `#${index}`)
    })
  }

  /**
   * 合并一批 `defineMenus()` 的结果。
   *
   * @param defs - 菜单定义（树）
   * @param source - 来源标记，只用于报错信息
   * @throws key 重复、或某个 `permission` 未注册时抛出
   */
  register(defs: readonly MenuDef[], source = '匿名注册'): this {
    walkMenus(defs, (def) => {
      if (this.byKey.has(def.key)) {
        throw new Error(`[@taizan/nest-rbac] 菜单 key "${def.key}" 重复注册（来源：${source}）`)
      }
      if (def.permission !== undefined) {
        // 表达式可能是 'a|b'，逐个 code 校验；解析本身也会挡住通配写法。
        for (const code of collectExprCodes(def.permission)) {
          if (!this.permissions.has(code)) {
            throw new Error(
              `[@taizan/nest-rbac] 菜单 "${def.key}" 引用了未注册的权限点 "${code}"（来源：${source}）：` +
                `这样的菜单会被 pruneMenus 永远裁掉，前端表现是「功能凭空消失」且不报错`,
            )
          }
        }
      }
      this.byKey.set(def.key, def)
    })
    this.roots.push(...defs)
    return this
  }

  /** 全部根节点（含两侧）。 */
  all(): readonly MenuDef[] {
    return this.roots
  }

  /** 某一侧的根节点。`side` 不匹配的整棵子树都不会出现在结果里。 */
  bySide(side: MenuSide): MenuDef[] {
    return this.roots.filter((def) => def.side === side)
  }

  /** 按 key 取一个节点（含任意层级）。 */
  get(key: string): MenuDef | undefined {
    return this.byKey.get(key)
  }

  /** 是否注册过某个 key。 */
  has(key: string): boolean {
    return this.byKey.has(key)
  }

  /** 全树的 `(节点, 父 key)` 扁平列表，先序遍历。同步命令按它写 `Menu.parentKey`。 */
  flatten(): { def: MenuDef; parentKey?: string }[] {
    const out: { def: MenuDef; parentKey?: string }[] = []
    walkMenus(this.roots, (def, parentKey) => {
      out.push(parentKey === undefined ? { def } : { def, parentKey })
    })
    return out
  }

  /** 已注册的节点总数（含所有层级）。 */
  get size(): number {
    return this.byKey.size
  }
}

/**
 * 套餐功能项注册表。**只存不判**。
 *
 * 判定（`hasFeature` 的三态语义、`writeOnly` 的读写区分、`pathPrefixes` 的前缀匹配）
 * 全部在 `@taizan/billing-rules`；本包唯一的用法是把 key 集合交给 `pruneMenus` 当
 * `features` 的定义域参考，以及给平台后台的「套餐配置页」列一份可勾选清单。
 */
export class FeatureRegistry {
  private readonly byKey = new Map<string, FeatureDef>()

  constructor(defs: readonly FeatureDef[] = []) {
    this.register(defs)
  }

  /**
   * 登记一批功能项。
   *
   * @throws key 重复时抛出（同一个 key 两套 `pathPrefixes`，闸门会按哪一套走说不清）
   */
  register(defs: readonly FeatureDef[]): this {
    for (const def of defs) {
      if (this.byKey.has(def.key)) {
        throw new Error(`[@taizan/nest-rbac] 功能项 key "${def.key}" 重复注册`)
      }
      this.byKey.set(def.key, def)
    }
    return this
  }

  /** 全部功能项。 */
  all(): FeatureDef[] {
    return [...this.byKey.values()]
  }

  /** 是否登记过某个 key。 */
  has(key: string): boolean {
    return this.byKey.has(key)
  }

  /** 取一条功能项定义。 */
  get(key: string): FeatureDef | undefined {
    return this.byKey.get(key)
  }

  /** 全部功能项 key。 */
  keys(): string[] {
    return [...this.byKey.keys()]
  }

  /** 已登记的功能项数量。 */
  get size(): number {
    return this.byKey.size
  }
}
