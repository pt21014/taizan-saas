import type { MenuNode } from '@taizan/contracts'

/** {@link verifyComponentMap} 的结果。 */
export interface ComponentMapReport {
  /** 双向都对得上、且没有「有 path 无 componentKey」的菜单 */
  ok: boolean
  /** 菜单里引用了、但映射表里没有的 componentKey（用户点进去会白屏） */
  missing: string[]
  /** 映射表里登记了、但没有任何菜单引用的 componentKey（死代码，或菜单漏注册） */
  unused: string[]
  /** `type: 'MENU'` 且有 `path`、却没写 `componentKey` 的菜单 key（同样会白屏） */
  pathWithoutComponentKey: string[]
}

/** 只需要 key 的映射表形状：`ComponentMap`、`Set<string>`、`string[]` 都能喂进来。 */
export type ComponentKeySource = Readonly<Record<string, unknown>> | ReadonlySet<string> | string[]

function keysOf(source: ComponentKeySource): Set<string> {
  if (source instanceof Set) return new Set(source)
  if (Array.isArray(source)) return new Set(source)
  return new Set(Object.keys(source))
}

function walk(nodes: readonly MenuNode[], referenced: Set<string>, pathWithout: string[]): void {
  for (const node of nodes) {
    const componentKey = node.componentKey
    if (componentKey !== undefined && componentKey.length > 0) {
      referenced.add(componentKey)
    } else if (node.type === 'MENU' && node.path !== undefined && node.path.length > 0) {
      pathWithout.push(node.key)
    }
    if (node.children !== undefined && node.children.length > 0) {
      walk(node.children, referenced, pathWithout)
    }
  }
}

/**
 * 菜单注册表与前端组件映射表的**双向**对账（蓝图 §8 spec 7 `menu-route-map`）。
 *
 * ## 这个函数存在的理由
 *
 * `componentKey` 是后端菜单注册表和前端映射表之间唯一的连接点，两边靠肉眼对齐。
 * 漏一个的表现是「菜单点进去白屏，控制台一句话都没有」——这种 bug 只会由用户报上来。
 *
 * 本阶段 `apps/api/src/registry/component-keys.ts` 里那份手写清单是**临时真源**
 * （它自己的注释里写了「将来会被删掉」）。`apps/admin` / `apps/platform` 落地后，
 * 各自写一条 spec 把真源接管过来，不再依赖那份手抄清单：
 *
 * ```ts
 * // apps/admin/src/routes/component-map.spec.ts
 * import { verifyComponentMap } from '@taizan/admin-ui'
 * import { MENUS } from '@taizan/api-registry-fixture' // 或从 /auth/bootstrap 的快照读
 * import { componentMap } from './component-map'
 *
 * it('spec 7：菜单 componentKey 与 component-map 双向对齐', () => {
 *   const report = verifyComponentMap(adminMenus, componentMap)
 *   expect(report.missing).toEqual([])
 *   expect(report.unused).toEqual([])
 *   expect(report.pathWithoutComponentKey).toEqual([])
 * })
 * ```
 *
 * `unused` 也要断言为空：只查一个方向的话，删掉一个页面组件却忘删菜单，
 * 或者反过来，都还是能过。
 *
 * @param menus - 菜单树（`MenuDef[]` 或下发后的 `MenuNode[]` 都可以，只读 key/type/path/componentKey/children）
 * @param componentMap - 前端映射表，或它的 key 集合/数组
 */
export function verifyComponentMap(
  menus: readonly MenuNode[],
  componentMap: ComponentKeySource,
): ComponentMapReport {
  const registered = keysOf(componentMap)
  const referenced = new Set<string>()
  const pathWithoutComponentKey: string[] = []
  walk(menus, referenced, pathWithoutComponentKey)

  const missing = [...referenced].filter((key) => !registered.has(key)).sort()
  const unused = [...registered].filter((key) => !referenced.has(key)).sort()

  return {
    ok: missing.length === 0 && unused.length === 0 && pathWithoutComponentKey.length === 0,
    missing,
    unused,
    pathWithoutComponentKey,
  }
}

/** 把对账结果拼成一条能直接贴进断言失败信息里的人话。 */
export function describeComponentMapReport(report: ComponentMapReport): string {
  if (report.ok) return 'componentKey 双向对齐'
  const parts: string[] = []
  if (report.missing.length > 0) {
    parts.push(`菜单引用了但 component-map 里没有：${report.missing.join(', ')}`)
  }
  if (report.unused.length > 0) {
    parts.push(`component-map 里登记了但没有菜单引用：${report.unused.join(', ')}`)
  }
  if (report.pathWithoutComponentKey.length > 0) {
    parts.push(`有 path 却没有 componentKey 的菜单：${report.pathWithoutComponentKey.join(', ')}`)
  }
  return parts.join('；')
}
