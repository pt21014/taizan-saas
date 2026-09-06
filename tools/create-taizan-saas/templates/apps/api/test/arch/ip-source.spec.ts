/**
 * 蓝图 §8 spec 13 在**全仓**这一层的落地。
 *
 * `@taizan/ratelimit-core`（本身）与 `@taizan/nest-auth` 各自已经有一份同名 spec，
 * 分别守着「扫描器没坏」与「框架包源码里没有第二处直接取 IP」（见
 * `packages/nest-auth/src/ratelimit/ip-source.spec.ts` 的文件头）。
 *
 * 这一份补的是那两份没覆盖到的范围：**`apps/api/src` 全部**（应用自己的业务代码，
 * 任何一条控制器/服务顺手写一行 `req.headers['x-forwarded-for']` 都能拿到一个「看起来
 * 正常」的 IP，唯一的症状是限流对会伪造这个头的人不生效——运行时没有任何报错），
 * 以及**全部框架包的 `src`**（防止将来新加的包踩同一个坑，而不用每加一个包
 * 就去下游手抄一份 spec）。
 *
 * 白名单只有两类：
 * 1. `@taizan/ratelimit-core` 自己（`resolveIps` 的实现文件 + 扫描器自身，
 *    见 {@link DEFAULT_IP_SOURCE_ALLOWLIST}）；
 * 2. `@taizan/nest-core` 的 `context/ip-resolver.ts`——**唯一**把 `req` 拆成
 *    `{ xff, socketIp }` 喂给 `resolveIps` 的注入点，那两行各自带着
 *    `// ip-source-ok:` 的书面理由。
 *
 * 不在白名单里的其它任何文件——包括 `@taizan/nest-auth` 的 `ratelimit/ip-resolver.ts`——
 * 都不允许直接碰原始头：那个适配器只转发 `ConfigService` 给的 `trustedHops` 和
 * `resolveIps` 的返回值，本身不读 `req`。
 *
 * ## 哨兵
 *
 * 正则失效时「扫不到任何违规」和「代码完全合规」长得一模一样，所以先拿
 * {@link IP_SOURCE_SENTINEL_SOURCE} 验一遍扫描器还活着，这是蓝图 §8 spec 1 用过的同一招。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_IP_SOURCE_ALLOWLIST,
  IP_SOURCE_SENTINEL_EXPECTATION,
  IP_SOURCE_SENTINEL_SOURCE,
  scanDirectIpReads,
  type IpSourceFile,
} from '@taizan/ratelimit-core'
import { describe, expect, it } from 'vitest'

import { APP_ROOT, SRC_DIR } from './_helpers'

/** 仓库根目录（`apps/api` 的上两级）。 */
const REPO_ROOT = resolve(APP_ROOT, '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/**
 * 递归收集一个目录下会跑在生产流量上的 `.ts`。
 *
 * 跳过 `.spec.ts`：测试夹具造假请求时必然要写 `x-forwarded-for` 这个头名
 * （`{ headers: { 'x-forwarded-for': '1.2.3.4' } }`），扫它们只会逼着每份测试
 * 挂一串豁免注释，稀释掉真正需要盯防的地方。
 */
function collect(dir: string): IpSourceFile[] {
  const out: IpSourceFile[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry)
      const stat = statSync(absolute)
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue
        walk(absolute)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      if (entry.endsWith('.d.ts') || entry.endsWith('.spec.ts')) continue
      out.push({ path: absolute, source: readFileSync(absolute, 'utf8') })
    }
  }
  walk(dir)
  return out
}

/** `packages/*\/src`，每个包各自的源码目录（没有 `src` 的包——例如纯配置包——跳过）。 */
function collectAllPackageSrc(): IpSourceFile[] {
  const out: IpSourceFile[] = []
  // 生成器改写：业务项目里没有 `packages/`（框架包是从 npm 装的），
  // 这一侧退化成空集合。框架仓库里它照常扫。
  if (!existsSync(PACKAGES_DIR)) return out
  for (const name of readdirSync(PACKAGES_DIR)) {
    const pkgDir = join(PACKAGES_DIR, name)
    if (!statSync(pkgDir).isDirectory()) continue
    const src = join(pkgDir, 'src')
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    out.push(...collect(src))
  }
  return out
}

/**
 * 白名单：两类见文件头。路径按后缀匹配，跟 `DEFAULT_IP_SOURCE_ALLOWLIST` 一样，
 * 不用管它俩在 Windows 上是反斜杠还是正斜杠——`scanDirectIpReads` 自己会归一化。
 */
const ALLOW = [...DEFAULT_IP_SOURCE_ALLOWLIST, 'nest-core/src/context/ip-resolver.ts']

describe('哨兵先跑：扫描器还活着', () => {
  it('故意写坏的样本必须被扫出预期条数', () => {
    const report = scanDirectIpReads([{ path: 'sentinel.ts', source: IP_SOURCE_SENTINEL_SOURCE }])
    expect(report.violations).toHaveLength(IP_SOURCE_SENTINEL_EXPECTATION.violationCount)
    expect(report.violations.map((v) => v.rule)).toEqual([...IP_SOURCE_SENTINEL_EXPECTATION.rules])
    expect(report.violations.map((v) => v.line)).toEqual([...IP_SOURCE_SENTINEL_EXPECTATION.lines])
  })
})

describe('全仓（apps/api + 全部框架包）没有第二处直接取 IP', () => {
  const files = [...collect(SRC_DIR), ...collectAllPackageSrc()]

  it('确实扫到了文件（否则下面那条断言是空转）', () => {
    // apps/api/src 加上十几个框架包，量级应该在几百个文件；给个宽松下限防 glob 写错。
    expect(files.length).toBeGreaterThan(100)
  })

  it('全绿', () => {
    const report = scanDirectIpReads(files, { allow: ALLOW })
    expect(report.violations.map((v) => v.message)).toEqual([])
    expect(report.scanned).toBeGreaterThan(100)
  })

  // 生成器改写：这条哨兵读的是 `packages/nest-core` 的源码。业务项目里没有那个目录，
  // 于是它必然找不到——那不是「扫描器坏了」，是「框架源码不在本仓库」。跳过它，
  // 而不是放宽它：放宽之后框架仓库里的哨兵也就没用了。
  it.skipIf(!existsSync(PACKAGES_DIR))('把唯一注入点的豁免注释抹掉，它**必须**被报出来——否则说明扫描器压根没在工作', () => {
    // 负控制：上面那条「全绿」如果是因为正则失效而全绿，看起来一模一样。
    const injectionPoint = files.find((f) =>
      f.path.replace(/\\/g, '/').endsWith('nest-core/src/context/ip-resolver.ts'),
    )
    expect(
      injectionPoint,
      '找不到唯一的 IP 解析注入点，路径可能变了，请同步改这条 spec',
    ).toBeDefined()
    const stripped = {
      path: 'stripped/ip-resolver.ts',
      source: (injectionPoint?.source ?? '').replace(/\/\/ ip-source-ok:.*/g, ''),
    }
    expect(scanDirectIpReads([stripped], { allow: [] }).violations.length).toBeGreaterThan(0)
  })

  it.skipIf(!existsSync(PACKAGES_DIR))('nest-auth 的 ratelimit/ip-resolver.ts 不在白名单里——它本来就不该碰原始头', () => {
    // 正面样本：这个文件只转发 ConfigService 给的 trustedHops 和 resolveIps 的返回值，
    // 真的不读 req，所以不需要豁免也该是绿的。这条测试确保将来有人往里塞一行
    // `req.headers['x-forwarded-for']` 会被真正拦下，而不是被误放进了白名单。
    expect(ALLOW.some((suffix) => suffix.includes('nest-auth'))).toBe(false)
    const adapter = files.find((f) =>
      f.path.replace(/\\/g, '/').endsWith('nest-auth/src/ratelimit/ip-resolver.ts'),
    )
    expect(adapter, '找不到 nest-auth 的 ip-resolver.ts，路径可能变了').toBeDefined()
  })
})
