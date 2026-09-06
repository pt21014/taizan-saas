/**
 * 蓝图 §8 **spec 14**：建租户的事务只允许出现在 `@taizan/provision` 的调用点。
 *
 * 守的不变量：**自助注册不能建出手工路径建不出来的租户**。
 *
 * 分开写过一次就会漂：以后加一张初始化的表、改一次角色预设、多一个默认字段，
 * 只改一边就出事。而漂掉的表现**不是报错**，是「从注册进来的店」和「运营手工开的店」
 * 在数据上不是同一种东西——一边建了配额计数器另一边没建，一边下发了全套角色
 * 另一边只给了 owner——然后所有下游逻辑都默认它们一样。xiaodian 就是这么坏掉的。
 *
 * ## 为什么白名单是**空的**
 *
 * T1-8 之前 `platform-tenant.service.ts` 里确实有一整块建店事务，那时它必须进白名单。
 * 现在它整块换成了 `provisionTenant(tx, …)`，`apps/api/src` 里**一处 `tenant.create(`
 * 都不该再有**——包括 `src/seed.ts`：它走 `@taizan/prisma-base` 的 `seedBase()`，
 * 演示租户那处 `tenant.upsert(` 在包里（`seed/demo-tenant.ts`），不在本次扫描范围内。
 *
 * 所以白名单空着不是「还没来得及填」，而是这条约束**当前真的没有例外**。
 * 扫描器对白名单是**双向**对账的：往里塞一条没有调用点的豁免，它会报
 * `stale-allowlist` 而不是默默通过——陈旧的白名单比没有白名单更糟，
 * 它让人以为那处豁免还有人在看。
 *
 * ## 哨兵
 *
 * 正则扫描最容易骗过自己的地方是「扫不到」和「没问题」在断言上长得一模一样。
 * `SENTINEL_SOURCE` 是一份故意造出来的输入，必须被扫出确定结果：
 * 正则一改坏，哨兵先炸。
 */

import {
  readSourceFiles,
  scanTenantCreateCalls,
  SENTINEL_EXPECTATION,
  SENTINEL_SOURCE,
} from '@taizan/provision/arch'
import { describe, expect, it } from 'vitest'

import { SRC_DIR } from './_helpers'

/**
 * 允许出现 `tenant.create(` / `upsert(` / `createMany(` 的文件。
 *
 * **每一条都必须写清理由**，没有理由的白名单等于没有白名单。
 * 现在一条都没有——见文件头「为什么白名单是空的」。
 */
const ALLOWLIST: readonly string[] = []

// `readSourceFiles` 自己会跳过 node_modules / dist / .turbo，并且**包含** `.spec.ts`
// （`_helpers.readSources` 会滤掉 spec，这里刻意不用它：一个把建店事务抄进测试夹具的
// spec 文件同样是第二条建店路径，它一样会被别人照着抄）。
const sources = readSourceFiles(SRC_DIR)
const report = scanTenantCreateCalls(sources, ALLOWLIST)

describe('spec 14：建租户只有一条路', () => {
  it('哨兵：扫描器本身没坏（扫不到东西和没有问题长得一模一样）', () => {
    const sentinel = scanTenantCreateCalls(
      [{ path: 'sentinel.ts', source: SENTINEL_SOURCE }],
      ['sentinel.ts'],
    )
    expect(sentinel.calls).toHaveLength(SENTINEL_EXPECTATION.calls)
    expect(sentinel.calls.map((c) => c.kind)).toEqual([...SENTINEL_EXPECTATION.kinds])
    // 白名单命中了，所以没有违规；同时也证明 `stale-allowlist` 那一半没有误报。
    expect(sentinel.violations).toEqual([])
  })

  it('哨兵反面：白名单里躺着一条没人用的豁免会被判 stale', () => {
    const stale = scanTenantCreateCalls(
      [{ path: 'sentinel.ts', source: SENTINEL_SOURCE }],
      ['sentinel.ts', 'src/some/file-that-never-creates-a-tenant.ts'],
    )
    expect(stale.violations.map((v) => v.rule)).toEqual(['stale-allowlist'])
  })

  it('真的扫到了 src 下的源码（扫了 0 个文件时下面全是空的，看起来像通过）', () => {
    expect(report.scannedFiles).toBeGreaterThan(40)
  })

  it('零违规：src/** 里不许再出现 tenant.create / upsert / createMany', () => {
    expect(
      report.violations.map((v) => v.message),
      '建租户只有一条路：改成 provisionTenant(tx, …)（@taizan/provision）。\n' +
        '再拼一遍的下场不是报错，是这条路建出来的租户少几张初始化的表，' +
        '而下游全都默认它和别人一样。',
    ).toEqual([])
  })

  it('白名单是空的——这条约束当前没有例外', () => {
    expect(
      ALLOWLIST,
      '要加豁免，先在这个数组上方写清「为什么这一处非自己建租户不可」。' +
        '写不出理由的，那就是第二条建店路径。',
    ).toEqual([])
    expect(report.calls, 'apps/api/src 里一处建租户的调用点都不该有').toEqual([])
  })

  it('平台后台那条路确实改成了 provisionTenant（不是把事务挪到了别处）', () => {
    const service = sources.find((f) =>
      f.path.endsWith('modules/platform/tenant/platform-tenant.service.ts'),
    )
    expect(service, '平台建租户的 service 找不到了？目录改名要同步改这条断言').toBeDefined()
    expect(service?.source).toContain('provisionTenant(')
    expect(service?.source).not.toContain('TODO(T1-8)')
  })

  it('自助注册那条路也走同一个函数（两条入口共用一份 deps 工厂）', () => {
    const service = sources.find((f) => f.path.endsWith('modules/public/signup/signup.service.ts'))
    expect(service, '自助注册的 service 找不到了？').toBeDefined()
    expect(service?.source).toContain('provisionTenant(')
    expect(service?.source).toContain("source: 'SIGNUP'")
    // 两条入口都用 `createProvisionDeps()`。各拼各的 deps，「一条路」会在依赖层重新裂开：
    // 口令哈希算法、角色预设回落表只改一边，两种店连口令格式都不是同一种。
    // 只看 service：DTO / 文档里提到 `provisionTenant()` 是正常的，它们不是调用点。
    const callers = sources.filter(
      (f) => f.path.endsWith('.service.ts') && f.source.includes('provisionTenant('),
    )
    expect(callers.length, 'provisionTenant 的调用点').toBeGreaterThanOrEqual(2)
    for (const caller of callers) {
      expect(caller.source, `${caller.path} 没用统一的 deps 工厂`).toContain('createProvisionDeps(')
    }
  })

  it('注册接口不下发 token（在这里签 token 等于开了第三条进后台的路）', () => {
    const signup = sources.filter((f) => f.path.includes('modules/public/signup/'))
    expect(signup.length).toBeGreaterThan(0)
    for (const file of signup) {
      // 注册成功后必须走一次正常登录：登录接口上挂着的验证码、失败限流、
      // 账号停用判定、换店重签逻辑，注册接口一条都没有。
      expect(file.source, `${file.path} 里出现了签发 token 的调用`).not.toMatch(
        /\b(?:loginStaff|issueRefresh|\.sign\()/,
      )
    }
  })
})
