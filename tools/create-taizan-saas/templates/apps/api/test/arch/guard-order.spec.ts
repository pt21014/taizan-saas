/**
 * **守卫链与拦截器链的顺序**（蓝图 §4.3）。
 *
 * 守的不变量：`GlobalAuthGuard → PermissionsGuard → BillingGateGuard` 这个顺序
 * 只在 `src/bootstrap/global-providers.ts` 的一个数组里定死，而且**没有第二处**
 * 往 `APP_GUARD` / `APP_INTERCEPTOR` 里塞东西。
 *
 * ## 为什么必须是静态断言，不能靠运行时测
 *
 * 顺序错了的表现是**放行**，不是报错：`PermissionsGuard` 排在认证之前时，
 * 它读 `req.principal` 读到 `undefined`，于是……在本框架里会抛 403（失败关闭），
 * 看起来好像还行。但 `BillingGateGuard` 排到认证之前会读不到 `principal.kind`，
 * 于是 `principal?.kind !== 'staff'` 成立，**直接 return true** —— 整条计费闸门
 * 静默失效。一条 e2e 都不会红，因为没有任何请求会失败。
 *
 * 更麻烦的是 Nest 的全局守卫顺序 = 「模块实例化顺序 → 数组顺序」，
 * 模块实例化顺序是 import 图的副产物。所以真正要守的不是「顺序对不对」，
 * 而是「所有守卫是不是都在同一个数组里」——只要都在一个数组里，顺序就只由那个数组决定。
 *
 * ## 断言的形状
 *
 * 从源码文本里解析出数组的**书写顺序**，与同一个文件导出的 `GUARD_ORDER` /
 * `INTERCEPTOR_ORDER` 常量比对。两边都得改才能通过——一份是给机器读的装配，
 * 一份是给人读的声明，任何一边单独改动都会红。
 */

import {
  GLOBAL_GUARDS,
  GLOBAL_INTERCEPTORS,
  GUARD_ORDER,
  INTERCEPTOR_ORDER,
  PLANNED_GUARD_ORDER,
} from '../../src/bootstrap/global-providers'
import { describe, expect, it } from 'vitest'

import { blankCommentsAndStrings, readSources, SRC_DIR } from './_helpers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const GLOBAL_PROVIDERS_FILE = 'src/bootstrap/global-providers.ts'

/**
 * `provideXxx()` 便捷函数 → 它实际装进去的那个类。
 *
 * 框架包导出这些函数是为了让应用侧不用记 `useExisting` 还是 `useClass`
 * （两者的差别是实例状态会不会分叉，见 global-providers.ts 的注释）。
 * 代价是解析器看不出它装的是谁，所以这里显式列一张表：
 * **出现了表外的 `provideXxx()`，这条 spec 直接抛错**，而不是悄悄少数一个守卫。
 */
const FACTORY_TO_CLASS: Readonly<Record<string, string>> = {
  providePermissionsGuard: 'PermissionsGuard',
  provideBillingGateGuard: 'BillingGateGuard',
  provideDataScopeInterceptor: 'DataScopeInterceptor',
  provideAuditInterceptor: 'AuditInterceptor',
  // `@taizan/nest-auth` 也导出一个 provideRateLimitGuard()，但它一次返回三个
  // provider（守卫本体 + APP_GUARD + APP_INTERCEPTOR），不适合塞进这张「一对一」的表——
  // global-providers.ts 里实际写的是字面量 `{ provide: APP_GUARD, useExisting: RateLimitGuard }`
  // 加一条独立的 `{ provide: APP_INTERCEPTOR, useClass: RetryAfterInterceptor }`。
  // 这一项留着以防将来真的换成那个便捷函数（换了这条 spec 不用回来改)。
  provideRateLimitGuard: 'RateLimitGuard',
}

/** 从 `open`（必须是 `[`）开始取一个配平的方括号块，返回结束位置（`]` 之后）。 */
function balancedBrackets(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '[') depth += 1
    else if (source[i] === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return source.length
}

/**
 * 解析 `export const <name>: Provider[] = [ … ]` 的书写顺序。
 *
 * 认三种写法：`useClass: X`、`useExisting: X`、`provideXxx()`。
 * 注释与字符串先被抹成等长空白（`blankCommentsAndStrings`），
 * 所以占位注释里的 `provideRateLimitGuard()` 不会被当成真的装上了。
 */
function parseProviderArray(source: string, name: string): string[] {
  const blanked = blankCommentsAndStrings(source)
  const declaration = blanked.indexOf(`export const ${name}`)
  if (declaration === -1) {
    throw new Error(`[guard-order.spec] 在 ${GLOBAL_PROVIDERS_FILE} 里找不到 ${name}`)
  }
  // 找 `= [` 而不是第一个 `[`：类型标注 `Provider[]` 里的那对方括号排在前面，
  // 从它开始配平会立刻闭合，于是解析出一个空数组——**看起来像「一个守卫都没装」，
  // 而那正是这条 spec 最该报出来的情况**，静默通过就等于没有这条 spec。
  const assign = /=\s*\[/.exec(blanked.slice(declaration))
  if (assign === null) {
    throw new Error(`[guard-order.spec] ${name} 的赋值不是一个数组字面量，解析器需要更新`)
  }
  const open = declaration + assign.index + assign[0].length - 1
  const body = blanked.slice(open, balancedBrackets(blanked, open))

  const out: string[] = []
  const token =
    /useClass:\s*([A-Za-z_$][\w$]*)|useExisting:\s*([A-Za-z_$][\w$]*)|\b(provide[A-Za-z_$][\w$]*)\s*\(/g
  for (const match of body.matchAll(token)) {
    const [, useClass, useExisting, factory] = match
    if (useClass !== undefined) {
      out.push(useClass)
      continue
    }
    if (useExisting !== undefined) {
      out.push(useExisting)
      continue
    }
    const mapped = FACTORY_TO_CLASS[factory as string]
    if (mapped === undefined) {
      throw new Error(
        `[guard-order.spec] ${name} 里出现了没登记的便捷函数 ${String(factory)}()。` +
          '请把它加进本 spec 的 FACTORY_TO_CLASS 表——解析器认不出它装的是哪个类，' +
          '就等于这条断言从此少数一个守卫。',
      )
    }
    out.push(mapped)
  }
  return out
}

const source = readFileSync(join(SRC_DIR, 'bootstrap', 'global-providers.ts'), 'utf8')

describe('守卫链顺序：解析器哨兵', () => {
  it('哨兵：解析器本身没坏（扫不到东西和顺序正确长得一模一样）', () => {
    const sentinel = `
      export const GLOBAL_GUARDS: Provider[] = [
        // provideRateLimitGuard(),  ← 注释里的不算
        { provide: APP_GUARD, useClass: GlobalAuthGuard },
        providePermissionsGuard(),
        provideBillingGateGuard(),
      ]
      export const GLOBAL_INTERCEPTORS: Provider[] = [
        { provide: APP_INTERCEPTOR, useExisting: SomethingElse },
      ]
    `
    expect(parseProviderArray(sentinel, 'GLOBAL_GUARDS')).toEqual([
      'GlobalAuthGuard',
      'PermissionsGuard',
      'BillingGateGuard',
    ])
    // 第二个数组要能被独立解析出来，否则上面那条可能只是「一路吃到文件尾」的巧合。
    expect(parseProviderArray(sentinel, 'GLOBAL_INTERCEPTORS')).toEqual(['SomethingElse'])
  })

  it('哨兵：没登记的 provideXxx() 会让 spec 抛错，而不是被静默跳过', () => {
    const sentinel = `export const GLOBAL_GUARDS: Provider[] = [provideMysteryGuard()]`
    expect(() => parseProviderArray(sentinel, 'GLOBAL_GUARDS')).toThrow(/没登记的便捷函数/)
  })
})

describe('守卫链顺序：真实装配', () => {
  it('守卫顺序恒为 GlobalAuthGuard → PermissionsGuard → BillingGateGuard', () => {
    expect(
      parseProviderArray(source, 'GLOBAL_GUARDS'),
      '认证必须最靠前（后面每一个都读 req.principal）；权限必须在计费之前' +
        '（「你没这个权限」比「店到期了」更准确）；计费最后（它是唯一会查库的）。',
    ).toEqual([...GUARD_ORDER])
  })

  it('拦截器顺序恒为 TransformInterceptor → DataScopeInterceptor → AuditInterceptor', () => {
    // TransformInterceptor 由 CoreModule 注册，不在本文件的数组里——
    // 它靠「CoreModule 是 imports 的第一个」排在最前，所以这里从第二项开始比。
    expect(INTERCEPTOR_ORDER[0]).toBe('TransformInterceptor')
    expect(
      parseProviderArray(source, 'GLOBAL_INTERCEPTORS'),
      '审计必须是最后一个：它记的是「最终结果」，排在别人前面会记成被改写前的响应。',
    ).toEqual([...INTERCEPTOR_ORDER].slice(1))
  })

  it('数组长度与声明常量一致（防止有人只加数组不改常量，或反过来）', () => {
    expect(GLOBAL_GUARDS).toHaveLength(GUARD_ORDER.length)
    expect(GLOBAL_INTERCEPTORS).toHaveLength(INTERCEPTOR_ORDER.length - 1)
  })

  it('计划中的守卫**还没有**被装上（装上了就该从 PLANNED_GUARD_ORDER 里删掉）', () => {
    const actual = parseProviderArray(source, 'GLOBAL_GUARDS')
    for (const planned of PLANNED_GUARD_ORDER) {
      expect(
        actual,
        `${planned.name} 已经装进 GLOBAL_GUARDS 了，请把它从 PLANNED_GUARD_ORDER 里删掉，` +
          '并确认它排在 ' +
          planned.before +
          ' 之前。',
      ).not.toContain(planned.name)
      // 占位注释里写的插入位置得是真实存在的一项，否则那条 TODO 指向空气。
      expect(actual).toContain(planned.before)
    }
  })
})

describe('守卫链顺序：没有第二处注册点', () => {
  const others = readSources(SRC_DIR, (path) => path !== GLOBAL_PROVIDERS_FILE)

  it('真的扫到了源码（一个都没扫到会让下面全绿）', () => {
    expect(others.length).toBeGreaterThanOrEqual(20)
  })

  it('除 global-providers.ts 外，没有任何文件出现 APP_GUARD / APP_INTERCEPTOR', () => {
    const offenders = others
      .filter((file) => /\bAPP_(GUARD|INTERCEPTOR)\b/.test(blankCommentsAndStrings(file.source)))
      .map((file) => file.path)
    expect(
      offenders,
      '守卫/拦截器的顺序 = 模块实例化顺序 → 数组顺序。多一处注册点，顺序就变成 import 图的' +
        '副产物：改一行 import 就可能悄悄换掉守卫顺序，而错了的表现是「放行」，不是报错。',
    ).toEqual([])
  })
})
