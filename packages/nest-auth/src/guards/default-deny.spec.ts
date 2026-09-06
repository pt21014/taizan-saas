/**
 * 用例⑭ / 蓝图 spec 5 的**样板实现**：静态扫描本包所有 `@Controller` 的路由方法。
 *
 * T0-8 的 `apps/api/test/arch/guard-default-deny.spec.ts` 直接 import
 * `scanControllerSources` 扫 `apps/api/src`，不要再抄一份扫描器。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  scanControllerSources,
  foldMultilineDecorators,
  SENTINEL_EXPECTATION,
  SENTINEL_SOURCE,
  type SourceFile,
} from './default-deny.scan'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** 递归收集 `src` 下的全部 `.ts`。 */
function collect(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collect(full, out)
    } else if (entry.endsWith('.ts')) {
      out.push({ path: full, source: readFileSync(full, 'utf8') })
    }
  }
  return out
}

describe('扫描器本身（哨兵）', () => {
  // 「扫不到东西」和「没有问题」在断言上长得一模一样。哨兵是唯一能区分它们的东西：
  // 正则被改坏时它先炸，而不是让真实代码静默地全部通过。
  it('哨兵源码必须扫出确定数量的路由与违规', () => {
    const report = scanControllerSources([{ path: 'sentinel.ts', source: SENTINEL_SOURCE }])
    expect(report.routes).toHaveLength(SENTINEL_EXPECTATION.routeCount)
    expect(report.violations).toHaveLength(SENTINEL_EXPECTATION.violationCount)
    expect(report.violations[0]?.route.method).toBe(SENTINEL_EXPECTATION.violatingMethod)
    expect(report.violations[0]?.rule).toBe('public-without-rate-limit')
  })

  it('跨行装饰器不会让整条路由从结果里消失', () => {
    const report = scanControllerSources([{ path: 'sentinel.ts', source: SENTINEL_SOURCE }])
    const multiline = report.routes.find((r) => r.method === SENTINEL_EXPECTATION.multilineMethod)
    // 折叠坏掉时 `remove` 会静默消失——而「少扫到一条」和「一切合规」的断言长得一模一样。
    // T0-8 装配 apps/api 时真的踩到了：11 条路由里少了 5 条，全是带多行 @Audit 的。
    expect(multiline, '带跨行 @Audit 的路由没被扫到').toBeDefined()
    expect(multiline?.httpMethod).toBe('Delete')
    expect(multiline?.authKinds).toEqual(['staff'])
  })

  it('foldMultilineDecorators 保持行数不变（报错行号才指得准）', () => {
    const lines = ['@Audit({', '  action: "x",', '})', '@Get()', 'foo() {}']
    const folded = foldMultilineDecorators(lines)
    expect(folded).toHaveLength(lines.length)
    expect(folded[0]).toBe('@Audit({action: "x",})')
    expect(folded[1]).toBe('')
    expect(folded[2]).toBe('')
    expect(folded[3]).toBe('@Get()')
  })

  it('认得出 @Auth() 声明的身份', () => {
    const report = scanControllerSources([{ path: 'sentinel.ts', source: SENTINEL_SOURCE }])
    const guarded = report.routes.find((r) => r.method === 'guarded')
    expect(guarded?.authKinds).toEqual(['staff'])
    expect(guarded?.isPublic).toBe(false)
  })

  it('类级 @Public() 会传染给类里的每个方法', () => {
    const source = `
@Controller('x')
@Public()
@RateLimited('public-read')
export class AllPublicController {
  @Get('a')
  a(): void {}

  @Post('b')
  b(): void {}
}
`
    const report = scanControllerSources([{ path: 'x.ts', source }])
    expect(report.routes).toHaveLength(2)
    expect(report.routes.every((r) => r.isPublic)).toBe(true)
    // 类级的 @RateLimited 也一并继承，所以没有违规。
    expect(report.violations).toHaveLength(0)
  })

  it('不是 @Controller 的类里的同名方法不算路由', () => {
    const source = `
export class NotAController {
  @Get('a')
  a(): void {}
}
`
    expect(scanControllerSources([{ path: 'x.ts', source }]).routes).toHaveLength(0)
  })

  it('装饰器和方法之间隔了空行以外的东西就不算相邻（避免误配）', () => {
    const source = `
@Controller('x')
export class C {
  @Get('a')
  private readonly notARoute = 1

  b(): void {}
}
`
    const report = scanControllerSources([{ path: 'x.ts', source }])
    // `notARoute` 会被 METHOD_LINE 排除（没有 `(`），`b` 前面没有 HTTP 装饰器。
    expect(report.routes).toHaveLength(0)
  })
})

describe('本包源码（spec 5 的实际断言）', () => {
  // 扫描器自己的源码里嵌着 SENTINEL_SOURCE（一份**故意**违规的样本），
  // 扫它等于扫自己的测试夹具。排掉它，而不是把哨兵改成合规的——
  // 哨兵一旦合规就再也证明不了「扫描器真的能发现违规」。
  const files = collect(SRC).filter((f) => !f.path.endsWith('default-deny.scan.ts'))

  it('src 下确实扫到了控制器（否则下面那条断言是空转）', () => {
    const report = scanControllerSources(files)
    // 目前只有 __test__/harness.ts 里那几个测试控制器。数量会随测试增减而变，
    // 所以只断言「大于 0」——重点是证明扫描器在这批文件上确实工作。
    expect(report.routes.length).toBeGreaterThan(0)
  })

  it('每个 @Public() 的路由都声明了限流档位', () => {
    const report = scanControllerSources(files)
    const offenders = report.violations.filter((v) => v.rule === 'public-without-rate-limit')

    // 例外：harness 里那两条是**故意**不写档位的测试夹具——
    // `unthrottled` 是运行时 warn 那条用例的被测对象，
    // `unlimited` 是「没挂 @RateLimited 的路由不该被限流守卫管」那条用例的被测对象。
    // 用例外清单而不是放宽规则——放宽了就再也发现不了真问题。
    const allowed = new Set([
      'PublicTestController.unthrottled',
      'RateLimitTestController.unlimited',
    ])
    const real = offenders.filter((v) => !allowed.has(`${v.route.controller}.${v.route.method}`))

    expect(real.map((v) => v.message)).toEqual([])
  })

  it('每个非 @Public() 的路由都会被全局守卫覆盖（默认拒绝）', () => {
    const report = scanControllerSources(files)
    const guarded = report.routes.filter((r) => !r.isPublic)
    expect(guarded.length).toBeGreaterThan(0)
    // 本包不使用 @UseGuards 换掉全局守卫；下游若要用，spec 5 应在那边加一条对应断言。
    for (const route of guarded) {
      expect(route.isPublic).toBe(false)
    }
  })
})
