/**
 * 「公众号来源判定只有一份」的机器守卫——**样板**。
 *
 * 业务项目照抄这个文件，把 `srcDir` / `callers` / `delegators` / `allow` 换成自己的。
 * 本包里没有真正的调用方（它就是那份判定本身），所以用 `__fixtures__/` 里的假源码验证
 * 扫描器确实拦得住，再顺手扫一遍本包自己的 `src`。
 *
 * 两半，和蓝图 spec 12 是同一个思路：
 * 1. **哨兵**——先喂一段人造的「坏代码」，确认规则真的报得出来。
 *    没有这一半，正则一旦写错，下面那半会永远绿，而绿的原因是「什么都没匹配到」。
 * 2. **自扫**——本包 `src/**` 必须零违规。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertMpSourceUsed, scanDirectAppIdReads } from './mp-source'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)))
const FIXTURES = join(SRC, '__fixtures__', 'mp-source-usage')

describe('哨兵：扫描器真的抓得到违规', () => {
  it('直接读平台 appId/appSecret 的文件会被点名（文件 + 行号）', () => {
    const hits = scanDirectAppIdReads(FIXTURES, { allow: ['good/mp.config.ts'] })
    expect(hits.map((h) => h.file)).toEqual(['bad/jssdk.service.ts'])
    expect(hits[0]?.line).toBeGreaterThan(0)
    expect(hits[0]?.text).toContain('platformMp')
  })

  it('白名单里的文件放行——配置文件本身当然要读它', () => {
    const hits = scanDirectAppIdReads(FIXTURES, { allow: [] })
    expect(hits.map((h) => h.file).sort()).toEqual(['bad/jssdk.service.ts', 'good/mp.config.ts'])
  })

  it('spec 文件不算数，否则这个文件自己就会把自己扫出来', () => {
    const hits = scanDirectAppIdReads(SRC, { ignoreDirs: ['__fixtures__'] })
    expect(hits.every((h) => !h.file.endsWith('.spec.ts'))).toBe(true)
  })

  it('调用方没调 resolveMpSource 会被抓出来', () => {
    expect(() =>
      assertMpSourceUsed({
        srcDir: FIXTURES,
        callers: ['good/notify.service.ts'],
        allow: ['good/mp.config.ts', 'bad/jssdk.service.ts'],
      }),
    ).toThrow(/没有调用 resolveMpSource/)
  })

  it('委托方自己又判了一遍也会被抓出来——两份规则迟早不一致', () => {
    expect(() =>
      assertMpSourceUsed({
        srcDir: FIXTURES,
        delegators: ['good/auth.service.ts'],
        delegateTo: 'resolveMpSource',
        allow: ['good/mp.config.ts', 'bad/jssdk.service.ts'],
      }),
    ).toThrow(/又判了一遍/)
  })

  it('全部守规矩时不抛（把违规的那份夹具排除掉）', () => {
    expect(() =>
      assertMpSourceUsed({
        srcDir: join(FIXTURES, 'good'),
        callers: ['auth.service.ts'],
        delegators: ['notify.service.ts'],
        allow: ['mp.config.ts'],
      }),
    ).not.toThrow()
  })
})

describe('自扫：本包不许有人绕开 resolveMpSource', () => {
  it('src/** 零违规', () => {
    const hits = scanDirectAppIdReads(SRC, { ignoreDirs: ['__fixtures__', 'node_modules', 'dist'] })
    expect(hits, `绕开了来源判定：\n${hits.map((h) => `${h.file}:${h.line}`).join('\n')}`).toEqual(
      [],
    )
  })
})
