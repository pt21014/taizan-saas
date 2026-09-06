/**
 * 蓝图 §8 **spec 7**：菜单注册表 ↔ 前端 `componentKey` 映射表的对账。
 *
 * 三条断言（判定在 `@taizan/nest-rbac` 的 `verifyMenuComponentMap`，本文件只提供输入）：
 *
 * 1. 每个有 `componentKey` 的菜单，那个 key 必须有映射——没有的话用户点进去是**白屏**，
 *    控制台里一句 warn 都没有；
 * 2. 每个带 `path` 的 `MENU` 必须同时有 `componentKey`——有路由没组件，同样白屏；
 * 3. 每个带 `permission` 的菜单，那个权限点必须已注册——否则 `pruneMenus` 会把它
 *    永远裁掉，表现是「这个功能凭空消失了」。
 *
 * ## 真源交接（TODO(T3-2) 已完成）
 *
 * `apps/api/src/registry/component-keys.ts` 那份手写清单是**临时**真源，写它的时候
 * `apps/admin` 还不存在。现在 `apps/admin`（与 `apps/platform`）都已经落地，真源
 * 换成**直接读前端源码**：{@link extractComponentMapKeys} 静态解析
 * `apps/admin/src/routes/component-map.ts`（ADMIN 侧）与
 * `apps/platform/src/routes/component-map.ts`（PLATFORM 侧，如果存在）里
 * `defineComponentMap({ Key: lazy(...), ... })` 的顶层 key。
 *
 * 不直接 `import` 那两个文件：它们依赖 `react`/`@taizan/admin-ui` 的浏览器侧产物，
 * 在 `apps/api` 的 Node vitest 环境里没有理由装这两个前端专用的运行时依赖——而且
 * 真正要守住的只是「这些 componentKey 字符串有没有登记」，不需要真的实例化组件。
 * 用静态解析而不是要求前端额外导出一份 JSON 快照，是因为**改了 component-map.ts
 * 忘了同步**这件事在快照方案下是「忘了跑一个命令」，在这里是「不可能发生」——
 * 这条 spec 读的就是 component-map.ts 此刻的内容，没有第二份可以过期的拷贝。
 *
 * PLATFORM 侧：`apps/platform/src/routes/component-map.ts` 现在已经存在，一并接上；
 * 万一将来它被删掉或改名，`existsSync` 兜底跳过（不是本文件的改动范围）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { MenuDef } from '@taizan/contracts'
import { verifyMenuComponentMap } from '@taizan/nest-rbac'
import { describe, expect, it } from 'vitest'

import { ADMIN_MENUS, ALL_MENUS, PLATFORM_MENUS } from '../../src/registry/menus'
import { PERMISSIONS } from '../../src/registry/permissions'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

const ADMIN_COMPONENT_MAP_FILE = here('../../../admin/src/routes/component-map.ts')
const PLATFORM_COMPONENT_MAP_FILE = here('../../../platform/src/routes/component-map.ts')

/**
 * 从 `defineComponentMap({ Key: lazy(...), ... })` 里静态抠出顶层 key。
 *
 * 两个前端的 `component-map.ts` 都是同一种书写惯例——一行一个
 * `<PascalCaseKey>: lazy(() => import(...))`——直接用「标识符 + 冒号 + lazy(」
 * 这个模式抓就够了，不需要真的解析 AST 或做括号配平。
 */
function extractComponentMapKeys(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf8')
  const keys = [...text.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*lazy\(/g)].map((m) => m[1] as string)
  if (keys.length === 0) {
    throw new Error(
      `[menu-route-map.spec] 在 ${filePath} 里没有解析出任何 "Key: lazy(" 形式的 componentKey，` +
        '是不是 component-map.ts 的写法变了？这份解析逻辑需要跟着改。',
    )
  }
  return keys
}

const ADMIN_COMPONENT_KEYS = extractComponentMapKeys(ADMIN_COMPONENT_MAP_FILE)
const PLATFORM_COMPONENT_KEYS_EXISTS = existsSync(PLATFORM_COMPONENT_MAP_FILE)
const PLATFORM_COMPONENT_KEYS = PLATFORM_COMPONENT_KEYS_EXISTS
  ? extractComponentMapKeys(PLATFORM_COMPONENT_MAP_FILE)
  : []

/** 两侧前端 component-map 的 key 并集——`verifyMenuComponentMap` 不区分 side，喂合集即可。 */
const COMPONENT_KEY_SET: ReadonlySet<string> = new Set([
  ...ADMIN_COMPONENT_KEYS,
  ...PLATFORM_COMPONENT_KEYS,
])

const report = verifyMenuComponentMap(ALL_MENUS, COMPONENT_KEY_SET, { permissions: PERMISSIONS })

/** 把菜单树摊平，方便逐条断言。 */
function flatten(menus: readonly MenuDef[]): MenuDef[] {
  return menus.flatMap((def) => [def, ...flatten(def.children ?? [])])
}

const flat = flatten(ALL_MENUS)

describe('spec 7：菜单 ↔ componentKey 映射对账', () => {
  it('哨兵：校验器本身没坏（一条违规都造不出来才是真的坏了）', () => {
    const broken: MenuDef[] = [
      // 有 componentKey 但映射表里没有 → missing-component
      { key: 's1', title: '哨兵1', type: 'MENU', side: 'ADMIN', componentKey: 'NoSuchPage' },
      // 有 path 没 componentKey → path-without-component
      { key: 's2', title: '哨兵2', type: 'MENU', side: 'ADMIN', path: '/nowhere' },
      // 引用了未注册的权限点 → unknown-permission
      {
        key: 's3',
        title: '哨兵3',
        type: 'MENU',
        side: 'ADMIN',
        componentKey: 'GoodsList',
        permission: 'nope:read',
      },
    ]
    const sentinel = verifyMenuComponentMap(broken, COMPONENT_KEY_SET, { permissions: PERMISSIONS })
    expect(sentinel.violations.map((v) => v.rule).sort()).toEqual([
      'missing-component',
      'path-without-component',
      'unknown-permission',
    ])
  })

  it('哨兵：ADMIN 侧真的解析出了 componentKey（真源没有悄悄变成空集合）', () => {
    expect(ADMIN_COMPONENT_KEYS.length).toBeGreaterThan(0)
    expect(ADMIN_COMPONENT_KEYS).toContain('GoodsList')
    expect(ADMIN_COMPONENT_KEYS).toContain('StaffList')
  })

  it('真的有菜单可扫（空注册表会让下面全绿）', () => {
    expect(flat.length).toBeGreaterThanOrEqual(2)
    expect(COMPONENT_KEY_SET.size).toBeGreaterThan(0)
  })

  it('零违规', () => {
    expect(report.violations.map((v) => `${v.rule} @${v.menuKey}: ${v.message}`)).toEqual([])
  })

  it('每个可点击菜单（有 path）都登记了 componentKey，且 key 在两侧 component-map 里', () => {
    const clickable = flat.filter((def) => def.type === 'MENU' && def.path !== undefined)
    expect(clickable.length).toBeGreaterThan(0)
    for (const def of clickable) {
      expect(def.componentKey, `菜单 ${def.key} 有 path 却没有 componentKey`).toBeTruthy()
      expect(
        COMPONENT_KEY_SET.has(def.componentKey as string),
        `菜单 ${def.key} 的 componentKey "${String(def.componentKey)}" 在 apps/admin 或 apps/platform ` +
          '的 component-map.ts 里都没登记',
      ).toBe(true)
    }
  })

  it('两侧 component-map 里没有多余的 componentKey（登记了却没有菜单用它）', () => {
    expect(
      report.unusedComponentKeys,
      '这些 key 在 apps/admin/apps/platform 的 component-map.ts 里登记了，但没有任何菜单引用；' +
        '要么是删菜单时忘了删组件映射，要么是组件映射写错了字。',
    ).toEqual([])
  })

  it('两侧菜单分开可比对（spec 7 分别对两个前端的 component-map）', () => {
    expect(ALL_MENUS.length).toBe(ADMIN_MENUS.length + PLATFORM_MENUS.length)
    expect(ADMIN_MENUS.every((def) => def.side === 'ADMIN')).toBe(true)
    expect(PLATFORM_MENUS.every((def) => def.side === 'PLATFORM')).toBe(true)
  })

  it('哨兵：这条 spec 真的在读 apps/admin 的源文件，不是缓存了一份旧结果', () => {
    // 只是重新解析一遍，证明 extractComponentMapKeys 是幂等且真的落在磁盘文件上，
    // 不是本文件顶层算出来之后就再也不会变的常量——用「删一个键再跑一次」验收时，
    // 这条断言能帮着排除「是不是 vitest 缓存了模块」的疑虑。
    expect(extractComponentMapKeys(ADMIN_COMPONENT_MAP_FILE)).toEqual(ADMIN_COMPONENT_KEYS)
  })
})
