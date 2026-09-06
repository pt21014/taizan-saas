/**
 * 蓝图 §8 **spec 6**：`@RequirePermission` 使用点 ↔ 权限点注册表的**双向**对账。
 *
 * 两个方向各守一种「不会报错的错」：
 *
 * | 方向 | 出事的样子 |
 * |---|---|
 * | 源码 → 注册表 | `@RequirePermission('goods:lst')` 拼错了一个字母。那条路由从此永远 1340300，运行时只有一条 error 日志，商家来说「这个按钮点了没反应」 |
 * | 注册表 → 源码 | 注册了一个没有任何路由/菜单引用的 **死权限**。它照样出现在角色配置页上，运营勾上它以为开了什么，实际什么也没开 |
 *
 * 扫描器用的是 `@taizan/nest-rbac` 导出的 `scanRequirePermissionUsages` /
 * `crossCheckPermissions`——**不在下游重抄一份**，那样两边的正则会慢慢走偏。
 * 它自带哨兵（`SENTINEL_SOURCE`），正则失效时哨兵先炸，
 * 而不是让真实代码「一条都没扫到」地假通过。
 */

import {
  crossCheckPermissions,
  scanRequirePermissionUsages,
  SENTINEL_EXPECTATION,
  SENTINEL_SOURCE,
} from '@taizan/nest-rbac'
import { describe, expect, it } from 'vitest'

import { ALL_MENUS } from '../../src/registry/menus'
import { ALL_PERMISSION_CODES, PERMISSIONS } from '../../src/registry/permissions'
import { readSources, SRC_DIR } from './_helpers'

/**
 * 允许存在的「死权限」白名单。
 *
 * **每一条都必须写清理由**——没有理由的白名单等于没有白名单。
 * 现在一条都没有：`goods:export` 虽然是 `BUTTON` 类（服务端扫不到前端的
 * `usePerm()` 调用），但它同时挂在 `GET /api/admin/goods/export` 上，扫得到。
 */
const ALLOW_UNUSED: readonly string[] = []

const sources = readSources(SRC_DIR).map((file) => ({ path: file.path, source: file.source }))
const usages = scanRequirePermissionUsages(sources)
const report = crossCheckPermissions(usages, PERMISSIONS, {
  menus: ALL_MENUS,
  allowUnused: ALLOW_UNUSED,
  // 只查 `API` 类的死权限。`BUTTON` 类天生只在前端 `usePerm(code)` 里用，
  // 服务端扫不到它的引用，把它算进来会逼所有人往白名单里塞东西。
  checkTypes: ['API'],
})

describe('spec 6：权限点注册表与 @RequirePermission 双向对账', () => {
  it('哨兵：扫描器本身没坏（扫不到东西和没有问题长得一模一样）', () => {
    const sentinel = scanRequirePermissionUsages([{ path: 'sentinel.ts', source: SENTINEL_SOURCE }])
    expect(sentinel).toHaveLength(SENTINEL_EXPECTATION.usages)
    expect([...new Set(sentinel.flatMap((u) => u.codes))].sort()).toEqual([
      ...SENTINEL_EXPECTATION.codes,
    ])
  })

  it('真的扫到了源码与使用点（一个都没扫到会让下面全绿）', () => {
    expect(sources.length).toBeGreaterThanOrEqual(20)
    expect(
      usages.length,
      '一处 @RequirePermission 都没扫到？要么正则失效了，要么真的一条路由都没声明权限——' +
        '两种都该红。',
    ).toBeGreaterThanOrEqual(4)
  })

  it('注册表非空，且 ALL_PERMISSION_CODES 与它一致', () => {
    expect(ALL_PERMISSION_CODES.length).toBeGreaterThan(0)
    expect([...ALL_PERMISSION_CODES].sort()).toEqual(Object.keys(PERMISSIONS).sort())
  })

  it('源码里引用的每个 code 都在注册表里（拼错 = 那条路由永远 1340300）', () => {
    const unregistered = report.violations.filter((v) => v.rule === 'unregistered-code')
    expect(unregistered.map((v) => v.message)).toEqual([])
  })

  it('注册表里的每个 API 权限点都被至少一个路由或菜单引用（没有死权限）', () => {
    const dead = report.violations.filter((v) => v.rule === 'dead-permission')
    expect(
      dead.map((v) => v.message),
      '死权限会出现在角色配置页上，运营勾上它以为开了什么，实际什么也没开。',
    ).toEqual([])
  })

  it('零违规（上面两条的合并断言，失败信息里能一次看全）', () => {
    expect(report.violations.map((v) => `${v.rule} ${v.code} ${v.at ?? ''}`)).toEqual([])
  })

  it('`@RequirePermission` 里不出现通配符（通配会随新增权限点静默放宽）', () => {
    // `parsePermissionExpr` 在装饰器求值时就会拒绝通配，所以这条理论上进不了库。
    // 留着它是因为那条校验在**框架包**里，而这条 spec 在应用侧——
    // 哪天框架放宽了，应用这边要能第一时间发现。
    const wildcards = usages.filter((u) => u.codes.some((code) => code.includes('*')))
    expect(wildcards.map((u) => `${u.file}:${u.line} ${u.raw}`)).toEqual([])
  })
})
