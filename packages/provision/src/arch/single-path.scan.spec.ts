import { describe, expect, it } from 'vitest'

import {
  SENTINEL_EXPECTATION,
  SENTINEL_SOURCE,
  readSourceFiles,
  scanTenantCreateCalls,
  stripCommentsAndStrings,
  type SourceFile,
} from './single-path.scan'

/** 一份「又拼了一遍建租户」的控制器。 */
const OFFENDER: SourceFile = {
  path: 'apps/api/src/modules/public/signup.service.ts',
  source: `
    async signup(dto) {
      return this.prisma.raw.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { slug: dto.slug } })
        return tenant
      })
    }
  `,
}

/** 一份规规矩矩调 provisionTenant 的控制器。 */
const GOOD: SourceFile = {
  path: 'apps/api/src/modules/platform/tenant/platform-tenant.service.ts',
  source: `
    async create(dto) {
      // raw-reason: 建租户是跨租户操作
      return this.raw.client.$transaction((tx) => provisionTenant(tx, dto, this.deps))
    }
  `,
}

describe('哨兵', () => {
  it('正则被改坏时先炸的是它', () => {
    const report = scanTenantCreateCalls(
      [{ path: 'sentinel.ts', source: SENTINEL_SOURCE }],
      ['sentinel.ts'],
    )
    expect(report.calls).toHaveLength(SENTINEL_EXPECTATION.calls)
    expect(report.calls.map((call) => call.kind)).toEqual([...SENTINEL_EXPECTATION.kinds])
    expect(report.violations).toEqual([])
  })

  it('只认 tenant：别的模型与读操作都不算', () => {
    const report = scanTenantCreateCalls([
      {
        path: 'x.ts',
        source: `
          await tx.subtenant.create({})
          await tx.staffAccount.create({})
          await tx.tenant.findUnique({ where: {} })
          await tx.tenant.count({})
        `,
      },
    ])
    expect(report.calls).toEqual([])
  })
})

describe('scanTenantCreateCalls / 双向', () => {
  it('方向一：白名单外的调用点报违规，白名单内的不报', () => {
    const report = scanTenantCreateCalls([OFFENDER, GOOD])

    expect(report.scannedFiles).toBe(2)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]?.rule).toBe('unallowed-tenant-write')
    expect(report.violations[0]?.at).toBe('apps/api/src/modules/public/signup.service.ts:4')
    expect(report.violations[0]?.message).toContain('provisionTenant')
  })

  it('豁免掉那个文件之后就干净了', () => {
    const report = scanTenantCreateCalls(
      [OFFENDER, GOOD],
      ['apps/api/src/modules/public/signup.service.ts'],
    )
    expect(report.violations).toEqual([])
  })

  it('方向二：白名单里的文件已经没有调用点了，报陈旧白名单', () => {
    const report = scanTenantCreateCalls([GOOD], ['apps/api/src/modules/legacy/old-signup.ts'])
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]?.rule).toBe('stale-allowlist')
    expect(report.violations[0]?.entry).toBe('apps/api/src/modules/legacy/old-signup.ts')
  })

  it('白名单按路径后缀双向匹配：在包目录里扫和在仓库根扫写同一条都认', () => {
    const shallow = scanTenantCreateCalls([
      { path: 'src/provision.ts', source: 'await tx.tenant.create({})' },
    ])
    const deep = scanTenantCreateCalls([
      { path: 'packages/provision/src/provision.ts', source: 'await tx.tenant.create({})' },
    ])
    expect(shallow.violations).toEqual([])
    expect(deep.violations).toEqual([])
  })
})

describe('stripCommentsAndStrings', () => {
  it('保留行数与非注释/字符串内容原样不变', () => {
    const source = 'const a = 1\nconst b = 2\n'
    expect(stripCommentsAndStrings(source)).toBe(source)
  })

  it('行注释被清空，但换行符与行号不变', () => {
    const source = 'const a = 1 // 之前是 tx.tenant.create(x)\nconst b = 2\n'
    const stripped = stripCommentsAndStrings(source)
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length)
    expect(stripped).not.toContain('tenant.create')
    expect(stripped.split('\n')[0]?.trim()).toBe('const a = 1')
  })

  it('块注释（含跨行）被清空，后面代码的行号不受影响', () => {
    const source = [
      '/*',
      ' * 旧写法：tx.tenant.create({ data: {} })',
      ' */',
      'await tx.tenant.create({ data: {} })',
      '',
    ].join('\n')
    const stripped = stripCommentsAndStrings(source)
    const lines = stripped.split('\n')
    expect(lines).toHaveLength(source.split('\n').length)
    expect(lines[0]?.trim()).toBe('')
    expect(lines[1]?.trim()).toBe('')
    expect(lines[2]?.trim()).toBe('')
    expect(lines[3]?.trim()).toBe('await tx.tenant.create({ data: {} })')
  })

  it('TSDoc（/** ... */）同样被清空', () => {
    const source = [
      '/**',
      ' * @example tx.tenant.create({ data: {} })',
      ' */',
      'function f() {}',
    ].join('\n')
    const stripped = stripCommentsAndStrings(source)
    expect(stripped).not.toContain('tenant.create')
    expect(stripped.split('\n')).toHaveLength(4)
  })

  it('字符串与模板字面量里的内容被清空（含转义引号）', () => {
    const source = [
      'const msg = "违规写法是 tenant.create( 别这么写"',
      "const msg2 = 'tenant.create(\\' 转义引号也不提前收尾'",
      'const msg3 = `模板里的 tenant.create( 也不算`',
    ].join('\n')
    const stripped = stripCommentsAndStrings(source)
    expect(stripped).not.toContain('tenant.create')
    expect(stripped.split('\n')).toHaveLength(3)
  })
})

describe('scanTenantCreateCalls / 注释与字符串不误判（spec 14 缺口修复）', () => {
  it('行注释里写 tenant.create( 不算违规', () => {
    const report = scanTenantCreateCalls([
      {
        path: 'x.ts',
        source: '// 之前这里是 tx.tenant.create({ data: {} })\nconst a = 1\n',
      },
    ])
    expect(report.calls).toEqual([])
  })

  it('块注释 / TSDoc 里写 tenant.create( 不算违规，真实调用点仍能被扫到且行号正确', () => {
    const source = [
      '/**',
      ' * 别再像这样写：tx.tenant.create({ data: {} })',
      ' */',
      'async function bad(tx) {',
      '  await tx.tenant.create({ data: {} })', // 真实调用，第 5 行
      '}',
    ].join('\n')
    const report = scanTenantCreateCalls([{ path: 'x.ts', source }])
    expect(report.calls).toHaveLength(1)
    expect(report.calls[0]?.line).toBe(5)
    expect(report.violations).toHaveLength(1)
  })

  it('字符串里写 tenant.create( 不算违规', () => {
    const report = scanTenantCreateCalls([
      {
        path: 'x.ts',
        source: 'const forbidden = "别写 tenant.create( 这种代码"\n',
      },
    ])
    expect(report.calls).toEqual([])
  })

  it('哨兵在剥了注释/字符串之后仍然精确扫出三处（防止误伤真实代码）', () => {
    const report = scanTenantCreateCalls(
      [{ path: 'sentinel.ts', source: SENTINEL_SOURCE }],
      ['sentinel.ts'],
    )
    expect(report.calls).toHaveLength(SENTINEL_EXPECTATION.calls)
    expect(report.calls.map((call) => call.kind)).toEqual([...SENTINEL_EXPECTATION.kinds])
  })
})

describe('readSourceFiles + 本包自扫', () => {
  it('读得到文件，且本包里除了那条路本身之外没有第二处建租户', () => {
    // 曾经这里要白名单 `single-path.scan.ts`（哨兵源码是个字符串字面量）与
    // `single-path.scan.spec.ts`（fixtures 里的 OFFENDER/GOOD 也是字符串字面量）——
    // 那正是 spec 14 缺口本身：字符串里的样例文本被正则误判成了真调用。
    // 剥了字符串之后这两处不再匹配，白名单也就不需要了；不需要空着传，
    // 免得将来又变回「陈旧白名单」。
    const report = scanTenantCreateCalls('src')
    // 扫了 0 个文件时下面的断言全都「通过」，所以先断言真的读到了东西
    expect(report.scannedFiles).toBeGreaterThan(5)
    expect(report.violations).toEqual([])
    expect(report.calls.some((call) => call.file.endsWith('src/provision.ts'))).toBe(true)
  })

  it('目录不存在时返回空数组，不抛', () => {
    expect(readSourceFiles('src/does-not-exist')).toEqual([])
  })
})
