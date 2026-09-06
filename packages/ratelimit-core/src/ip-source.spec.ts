/**
 * spec 13（`ip-source`）扫描器自身的用例 + 哨兵。
 *
 * 静态扫描类测试最容易骗过自己的地方是：**「扫不到东西」和「没有问题」长得一模一样**。
 * 所以第一组用例先拿一份故意写坏的哨兵源码验证扫描器还活着，再谈别的。
 *
 * 真正扫全仓的那一份在 `apps/api/test/arch/ip-source.spec.ts`（T0-8 接线时写），
 * 它直接 import 本包的 {@link scanDirectIpReads}，不要在下游再抄一遍正则。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IP_SOURCE_ALLOWLIST,
  IP_SOURCE_SENTINEL_EXPECTATION,
  IP_SOURCE_SENTINEL_SOURCE,
  scanDirectIpReads,
} from './ip-source'

const scan = (source: string, path = 'src/some.controller.ts') =>
  scanDirectIpReads([{ path, source }])

describe('哨兵：正则失效时先炸哨兵，而不是静默全绿', () => {
  const report = scanDirectIpReads([{ path: 'sentinel.ts', source: IP_SOURCE_SENTINEL_SOURCE }])

  it('扫出预期条数', () => {
    expect(report.violations).toHaveLength(IP_SOURCE_SENTINEL_EXPECTATION.violationCount)
  })

  it('每一条的规则与行号都对得上', () => {
    expect(report.violations.map((v) => v.rule)).toEqual([...IP_SOURCE_SENTINEL_EXPECTATION.rules])
    expect(report.violations.map((v) => v.line)).toEqual([...IP_SOURCE_SENTINEL_EXPECTATION.lines])
  })

  it('scanned 计数不为 0（防 glob 写错导致一个文件都没扫到还全绿）', () => {
    expect(report.scanned).toBe(1)
  })
})

describe('该报的', () => {
  it.each([
    ["req.headers['x-forwarded-for']", "const ip = req.headers['x-forwarded-for']"],
    ['大小写变体', "headers.get('X-Forwarded-For')"],
    ['取第一段这种经典写法', "const ip = String(req.headers['x-forwarded-for']).split(',')[0]"],
    ['req.ip', 'const ip = req.ip'],
    ['request.ip', 'const ip = request.ip'],
    ['可选链', 'const ip = req?.ip'],
    ['req.ips', 'const [ip] = req.ips'],
    ['socket.remoteAddress', 'const ip = req.socket.remoteAddress'],
    ['connection.remoteAddress', 'const ip = req.connection.remoteAddress'],
  ])('%s', (_label, line) => {
    expect(scan(line).violations).toHaveLength(1)
  })

  it('报错信息里说清了后果，而不是只说「不许这么写」', () => {
    const [v] = scan("const ip = req.headers['x-forwarded-for']").violations
    expect(v?.message).toContain('伪造')
    expect(v?.message).toContain('resolveIps')
  })
})

describe('不该报的', () => {
  it.each([
    ['注释里提到这个头（在解释，不是在读）', '// 不要直接读 x-forwarded-for，用 resolveIps'],
    ['TSDoc 里提到', ' * XFF 与 x-forwarded-for 的关系见 resolve-ips.ts'],
    ['形近但无关的字段', 'const r = req.ipRange'],
    ['正确写法', 'const ip = currentContext()?.ip.client'],
    ['另一种正确写法', 'const { client, edge } = resolveIps({ xff, socketIp, trustedHops })'],
  ])('%s', (_label, line) => {
    expect(scan(line).violations).toEqual([])
  })

  it('写了行内豁免理由的放过', () => {
    const line =
      "const raw = req.headers['x-forwarded-for'] // ip-source-ok: 这里是喂给 resolveIps 的唯一注入点"
    expect(scan(line).violations).toEqual([])
  })

  it('豁免注释里理由太短的不放过（`// ip-source-ok:` 光秃秃一句不算理由）', () => {
    const line = "const raw = req.headers['x-forwarded-for'] // ip-source-ok: x"
    expect(scan(line).violations).toHaveLength(1)
  })
})

describe('白名单', () => {
  it('默认放过 resolveIps 的实现文件本身与本扫描器', () => {
    const report = scanDirectIpReads([
      {
        path: 'packages/ratelimit-core/src/resolve-ips.ts',
        source: "req.headers['x-forwarded-for']",
      },
      {
        path: 'packages/ratelimit-core/src/ip-source.ts',
        source: "req.headers['x-forwarded-for']",
      },
    ])
    expect(report.violations).toEqual([])
    expect(report.skipped).toHaveLength(2)
    expect(report.scanned).toBe(0)
  })

  it('白名单按路径后缀匹配，Windows 反斜杠路径也认', () => {
    const report = scanDirectIpReads(
      [
        {
          path: 'D:\\project\\packages\\nest-auth\\src\\ratelimit\\ip-resolver.ts',
          source: 'req.ip',
        },
      ],
      { allow: [...DEFAULT_IP_SOURCE_ALLOWLIST, 'nest-auth/src/ratelimit/ip-resolver.ts'] },
    )
    expect(report.violations).toEqual([])
  })

  it('不在白名单里的文件照报', () => {
    const report = scanDirectIpReads(
      [{ path: 'packages/nest-auth/src/other.ts', source: 'req.ip' }],
      {
        allow: DEFAULT_IP_SOURCE_ALLOWLIST,
      },
    )
    expect(report.violations).toHaveLength(1)
  })
})

describe('拿本包自己的源码跑一遍（吃自己的狗粮）', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const files = ['config.ts', 'decide.ts', 'store.ts', 'index.ts'].map((name) => ({
    path: `packages/ratelimit-core/src/${name}`,
    source: readFileSync(`${here}${name}`, 'utf8'),
  }))

  it('除了 resolve-ips.ts 与扫描器本身，本包没有任何一处直接读 IP', () => {
    const report = scanDirectIpReads(files)
    expect(report.scanned).toBe(files.length)
    expect(report.violations.map((v) => v.message)).toEqual([])
  })
})
