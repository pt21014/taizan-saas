import { describe, expect, it } from 'vitest'
import { describeComponentMapReport, verifyComponentMap } from '@taizan/admin-ui'
import type { MenuNode } from '@taizan/contracts'
import platformMenusFixture from './__fixtures__/platform-menus.json'
import { componentMap } from './component-map'

/**
 * spec 7（蓝图 §8）：`componentKey` 双向对齐。
 *
 * `__fixtures__/platform-menus.json` 是 `apps/api/src/registry/menus.ts`（`PLATFORM_MENUS`，
 * 汇总了 `modules/platform/platform.menus.ts` 与 T3-4 新增的死信队列一条）的手抄快照
 * （只留 `verifyComponentMap` 需要的字段：key/title/icon/path/componentKey/type/sort，
 * 外加下发时会额外透传的 `permission`）。
 *
 * ## T3-4 之后：为什么仍然是手抄快照而不是直接读 bootstrap 响应
 *
 * `GET /api/platform/auth/bootstrap` 已经落地（`src/session.ts` 不再有静态兜底），
 * 但那是一个**运行时**接口，这条 spec 要在没有真实后端的单测环境里跑——继续维护一份
 * 本地快照，只是不再需要「同时保证运行期也有一份一致的静态菜单」这个理由了（那部分
 * 已经被删掉）。快照的**唯一职责**变成了「给 `verifyComponentMap` 一个比对基准」。
 * 与 `apps/api/test/arch/menu-route-map.spec.ts`（spec 7 的另一半，读的是真实
 * `registry/menus.ts`）两条 spec 分别兜底两侧：那一条保证后端注册表与两个前端
 * `component-map.ts` 对齐，这一条保证这份本地快照本身与 `component-map.ts` 对齐。
 * **这份快照需要跟 `apps/api/src/registry/menus.ts` 手工保持一致**，后端加菜单时
 * 如果忘了同步这里，这条 spec 会漏掉新页面（而不是「测试照样绿、页面进不去」那种
 * 更难查的漂移）。
 */
const PLATFORM_MENUS = platformMenusFixture as unknown as MenuNode[]

describe('spec 7：菜单 componentKey 与 component-map 双向对齐', () => {
  it('PLATFORM_MENUS 快照与 componentMap 完全对齐', () => {
    const report = verifyComponentMap(PLATFORM_MENUS, componentMap)
    expect(describeComponentMapReport(report)).toBe('componentKey 双向对齐')
    expect(report.missing).toEqual([])
    expect(report.unused).toEqual([])
    expect(report.pathWithoutComponentKey).toEqual([])
  })

  // 哨兵：证明上面那条 spec 真的会拦漂移，不是因为两边恰好都是空数组才绿的。
  it('哨兵——菜单多引用一个未登记的 componentKey 时，missing 必须非空', () => {
    const withExtraMenu: MenuNode[] = [
      ...PLATFORM_MENUS,
      {
        key: 'platform-job-dead-letter-sentinel',
        title: '哨兵：不存在的页面',
        type: 'MENU',
        path: '/__sentinel__',
        componentKey: 'PlatformSentinelNotRegistered',
        sort: 999,
      },
    ]
    const report = verifyComponentMap(withExtraMenu, componentMap)
    expect(report.ok).toBe(false)
    expect(report.missing).toEqual(['PlatformSentinelNotRegistered'])
  })

  it('哨兵——component-map 多登记一个没有菜单引用的 key 时，unused 必须非空', () => {
    const reportWithBogusMapKey = verifyComponentMap(PLATFORM_MENUS, {
      ...componentMap,
      PlatformSentinelUnused: componentMap.PlatformDashboard,
    })
    expect(reportWithBogusMapKey.ok).toBe(false)
    expect(reportWithBogusMapKey.unused).toEqual(['PlatformSentinelUnused'])
  })

  it('哨兵——MENU 节点有 path 却没 componentKey 时，pathWithoutComponentKey 必须非空', () => {
    const withBrokenMenu: MenuNode[] = [
      ...PLATFORM_MENUS,
      {
        key: 'platform-broken-menu-sentinel',
        title: '哨兵：漏配 componentKey',
        type: 'MENU',
        path: '/__broken__',
        sort: 998,
      },
    ]
    const report = verifyComponentMap(withBrokenMenu, componentMap)
    expect(report.ok).toBe(false)
    expect(report.pathWithoutComponentKey).toEqual(['platform-broken-menu-sentinel'])
  })
})
