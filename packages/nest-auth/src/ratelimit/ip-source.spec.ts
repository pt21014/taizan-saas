/**
 * 蓝图 §8 spec 13 在**框架包**这一层的落地：`@taizan/nest-core` 与 `@taizan/nest-auth`
 * 的源码里，除了那一个注入点，不许有第二处直接取 IP。
 *
 * 全仓那一份在 `apps/api/test/arch/ip-source.spec.ts`（T0-8/接线时写），
 * 用的是同一个 {@link scanDirectIpReads}，不要在下游再抄一遍正则。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IP_SOURCE_ALLOWLIST,
  IP_SOURCE_SENTINEL_EXPECTATION,
  IP_SOURCE_SENTINEL_SOURCE,
  scanDirectIpReads,
  type IpSourceFile,
} from '@taizan/ratelimit-core'

const AUTH_SRC = fileURLToPath(new URL('..', import.meta.url))
const CORE_SRC = join(AUTH_SRC, '..', '..', 'nest-core', 'src')

function collect(dir: string): IpSourceFile[] {
  const out: IpSourceFile[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...collect(full))
      continue
    }
    // 只扫会跑在生产流量上的代码。测试夹具里造假请求时必然要写这个头名
    // （`{ headers: { 'x-forwarded-for': ... } }`），扫它们只会逼着每份 spec 挂一串豁免注释。
    if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) continue
    out.push({ path: full, source: readFileSync(full, 'utf8') })
  }
  return out
}

/**
 * 白名单只有一条：`@taizan/nest-core` 的 `ip-resolver.ts`。
 *
 * 它是**唯一**把 `req` 拆成 `{ xff, socketIp }` 喂给 `resolveIps` 的地方，
 * 而且那两行各自带着 `// ip-source-ok:` 的书面理由（所以其实不靠白名单也能过，
 * 这里列出来是让「哪些文件被允许碰原始头」这件事在 spec 里一眼可见）。
 */
const ALLOW = [...DEFAULT_IP_SOURCE_ALLOWLIST, 'nest-core/src/context/ip-resolver.ts']

describe('哨兵先跑：扫描器还活着', () => {
  it('故意写坏的样本必须被扫出预期条数', () => {
    const report = scanDirectIpReads([{ path: 'sentinel.ts', source: IP_SOURCE_SENTINEL_SOURCE }])
    expect(report.violations).toHaveLength(IP_SOURCE_SENTINEL_EXPECTATION.violationCount)
  })
})

describe('框架源码里没有第二处直接取 IP', () => {
  const files = [...collect(AUTH_SRC), ...collect(CORE_SRC)]

  it('确实扫到了文件（否则下面那条断言是空转）', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('nest-auth + nest-core 全绿', () => {
    const report = scanDirectIpReads(files, { allow: ALLOW })
    expect(report.violations.map((v) => v.message)).toEqual([])
    expect(report.scanned).toBeGreaterThan(20)
  })

  it('把注入点的豁免注释抹掉，它**必须**被报出来——否则说明扫描器压根没在工作', () => {
    // 这一条是负控制：上面那条「全绿」如果是因为正则失效而全绿，看起来一模一样。
    // 拿真实的注入点源码、去掉那两行的 `// ip-source-ok:` 再扫一遍，必须报。
    const injectionPoint = files.find((f) =>
      f.path.split('\\').join('/').endsWith('nest-core/src/context/ip-resolver.ts'),
    )
    expect(injectionPoint).toBeDefined()
    const stripped = {
      path: 'stripped/ip-resolver.ts',
      source: (injectionPoint?.source ?? '').replace(/\/\/ ip-source-ok:.*/g, ''),
    }
    expect(scanDirectIpReads([stripped], { allow: [] }).violations.length).toBeGreaterThan(0)
  })
})
