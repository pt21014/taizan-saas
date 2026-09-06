/**
 * spec 12（蓝图 §8）：集群安全静态断言。
 *
 * 两半：
 * 1. **哨兵**——先用一组人造的「坏代码」喂给扫描器，确认每条规则都真的报得出来。
 *    没有这一半，正则一旦写错（比如某次重构把 `\b` 删了），下面那半会永远绿，
 *    而绿的原因是「什么都没匹配到」。spec 1 的「防假通过哨兵」是同一个思路。
 * 2. **本包自扫**——扫 `src/**` 全部非测试源码，必须零违规。
 *
 * 扫描器本身导出在 `@taizan/nest-infra/testing`，T0-8 的全仓 spec 与 T4-2 的生成器
 * 模板直接复用，不要各写一遍正则。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectSourceFiles } from './cluster-safe/collect'
import {
  formatViolations,
  scanClusterSafety,
  type ClusterSafetyViolation,
  type SourceFile,
} from './cluster-safe/scan'

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)))

function scanOne(content: string, path = 'src/bad.ts'): ClusterSafetyViolation[] {
  const file: SourceFile = { path, content }
  return scanClusterSafety([file])
}

describe('cluster-safe 扫描器（防假通过哨兵）', () => {
  it('抓得到裸 setInterval', () => {
    const found = scanOne(
      [
        '@Injectable()',
        'export class OrderCloseService {',
        '  onModuleInit() {',
        '    setInterval(() => this.closeExpired(), 30_000)',
        '  }',
        '}',
      ].join('\n'),
    )
    expect(found.map((v) => v.rule)).toContain('timer')
  })

  it('抓得到裸 setTimeout 做的自我重排', () => {
    expect(scanOne('setTimeout(() => tick(), 1000)').map((v) => v.rule)).toContain('timer')
  })

  it('加了 cluster-safe-allow 注释就放行', () => {
    const found = scanOne(
      ['// cluster-safe-allow: 只是一次性超时，不是调度', 'setTimeout(reject, 2000)'].join('\n'),
    )
    expect(found).toEqual([])
  })

  it('白名单文件（cron 调度器自身）放行', () => {
    const found = scanClusterSafety([
      { path: 'packages/nest-infra/src/cron/cron.scheduler.ts', content: 'setTimeout(fn, 1)' },
    ])
    expect(found).toEqual([])
  })

  it('抓得到 @nestjs/schedule 的 @Cron / @Interval / @Timeout', () => {
    expect(scanOne("  @Cron('0 9 * * *')").map((v) => v.rule)).toEqual(['nest-cron'])
    expect(scanOne('  @Interval(30000)').map((v) => v.rule)).toEqual(['nest-cron'])
    expect(scanOne('  @Timeout(5000)').map((v) => v.rule)).toEqual(['nest-cron'])
  })

  it('@Cron 即使写了 allow 注释也不放行（它没有 leader 选举，没有正当理由）', () => {
    const found = scanOne(['// cluster-safe-allow: 我就想用', "@Cron('* * * * *')"].join('\n'))
    expect(found.map((v) => v.rule)).toContain('nest-cron')
  })

  it('抓得到一次性凭据用 get 而不是 takeOnce', () => {
    expect(
      scanOne('const raw = await redis.get(`oauth:state:${state}`)').map((v) => v.rule),
    ).toEqual(['take-once'])
    expect(scanOne("await cache.get('wechat:ticket:' + id)").map((v) => v.rule)).toEqual([
      'take-once',
    ])
  })

  it('抓得到没标注的模块级 Map 与类字段 Map', () => {
    expect(scanOne('const tokenCache = new Map<string, string>()').map((v) => v.rule)).toEqual([
      'process-local',
    ])
    expect(
      scanOne(
        ['class A {', '  private readonly cache = new Map<string, string>()', '}'].join('\n'),
      ).map((v) => v.rule),
    ).toEqual(['process-local'])
    expect(scanOne('export const seenIds = new Set<string>()').map((v) => v.rule)).toEqual([
      'process-local',
    ])
  })

  it('标了 // process-local: 就放行', () => {
    const found = scanOne(
      [
        '// process-local: 只是本进程的定时器句柄',
        'const timers = new Map<string, NodeJS.Timeout>()',
      ].join('\n'),
    )
    expect(found).toEqual([])
  })

  it('函数体内的局部 Map 不算长驻容器（缩进 ≥4）', () => {
    const found = scanOne(
      [
        'function f() {',
        '  {',
        '    const seen = new Map<string, string>()',
        '    return seen',
        '  }',
        '}',
      ].join('\n'),
    )
    expect(found).toEqual([])
  })

  it('formatViolations 输出可读报告', () => {
    expect(formatViolations([])).toBe('（无）')
    expect(formatViolations(scanOne('setInterval(f, 1)'))).toContain('[timer]')
  })
})

describe('cluster-safe 自扫', () => {
  it('本包源码零违规', () => {
    const files = collectSourceFiles(SRC_DIR)
    // 哨兵之二：确认真的扫到了文件（路径写错时 files 是空数组，下面那条断言会假绿）
    expect(files.length).toBeGreaterThan(20)
    // 白名单是相对包根的，这里收到的路径是相对 src 的，补上前缀再比
    const violations = scanClusterSafety(files.map((f) => ({ ...f, path: `src/${f.path}` })))
    expect(violations, `\n发现集群安全违规：\n${formatViolations(violations)}\n`).toEqual([])
  })
})
