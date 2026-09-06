/**
 * 看板模块专属的架构约束：本目录（`src/modules/platform/dashboard/`）的非测试源码里
 * 一次 `findMany(` 都不许出现——看板只回汇总数字，`count`/`groupBy`/`aggregate` 能让
 * 数据库把「算总数」这件事做完，`findMany` 再在应用层数一遍是把全表搬进 Node 进程，
 * 见 `dashboard.service.ts` 文件头。
 *
 * ## 白名单：`dashboard-expiring.service.ts`（T3-4）
 *
 * 「即将到期的租户」是一份**明细列表**（哪几家、哪天到期），不是「有多少家」这种
 * 汇总数字——`count` 回答不了「是哪几家」。真正要守住的不变量是「零全表扫描」，
 * 不是「零 `findMany(`」这个字面禁令；该文件的 `findMany` 带 `skip`/`take`（分页），
 * 理由与用法细节见那个文件的头部注释。白名单只对这一个文件生效，其余文件仍然零豁免。
 *
 * 带哨兵：扫描器本身失效（比如把 `blankCommentsAndStrings` 换掉、正则写错）时哨兵先炸，
 * 不会让「一个违规都没扫到」被误读成「这个目录很干净」——这两者在断言上长得一模一样。
 *
 * @packageDocumentation
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  blankCommentsAndStrings,
  readSources,
  type SourceFile,
} from '../../../../test/arch/_helpers'

const DASHBOARD_DIR = dirname(fileURLToPath(import.meta.url))

const FIND_MANY_PATTERN = /\bfindMany\s*\(/g

/** 见文件头「白名单」一节，唯一允许出现 `findMany(` 的文件（分页明细，非全表扫描）。 */
const ALLOW_FIND_MANY: readonly string[] = ['dashboard-expiring.service.ts']

const files = readSources(
  DASHBOARD_DIR,
  (path: string) => !path.endsWith('.spec.ts') && !ALLOW_FIND_MANY.some((f) => path.endsWith(f)),
)

describe('看板模块：禁止 findMany（只许 count/groupBy/aggregate，dashboard-expiring.service.ts 白名单见文件头）', () => {
  it('哨兵：扫描器认得出真违规，也不会被注释里的反例骗到', () => {
    const withCode = 'await this.raw.client.tenant.findMany({ where: {} })'
    const withComment = '// 反面教材：千万别在看板里写 tenant.findMany({...})'

    const codeBlanked = blankCommentsAndStrings(withCode)
    const commentBlanked = blankCommentsAndStrings(withComment)

    FIND_MANY_PATTERN.lastIndex = 0
    expect(FIND_MANY_PATTERN.test(codeBlanked), '扫描器应该认得出真代码里的 findMany(').toBe(true)

    FIND_MANY_PATTERN.lastIndex = 0
    expect(FIND_MANY_PATTERN.test(commentBlanked), '注释被剥掉之后不该再命中').toBe(false)
  })

  it('真的扫到了看板模块的源码', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f: SourceFile) => f.path.endsWith('dashboard.service.ts'))).toBe(true)
  })

  it('本目录零 findMany(', () => {
    const violations = files.flatMap((file: SourceFile) => {
      const code = blankCommentsAndStrings(file.source)
      FIND_MANY_PATTERN.lastIndex = 0
      return code.match(FIND_MANY_PATTERN) ? [file.path] : []
    })
    expect(
      violations,
      '看板只回汇总数字，这些文件里出现了 findMany(——改用 count/groupBy/aggregate。',
    ).toEqual([])
  })

  it('白名单文件真的存在，且它的 findMany( 确实带 take（分页，不是全表扫描）', () => {
    const allFiles = readSources(DASHBOARD_DIR, (path) => !path.endsWith('.spec.ts'))
    const exempted = allFiles.find((f) => f.path.endsWith('dashboard-expiring.service.ts'))
    expect(
      exempted,
      'ALLOW_FIND_MANY 里登记的文件应该真实存在，否则这条白名单形同虚设',
    ).toBeTruthy()

    const code = blankCommentsAndStrings(exempted?.source ?? '')
    FIND_MANY_PATTERN.lastIndex = 0
    expect(
      FIND_MANY_PATTERN.test(code),
      '白名单文件本身至少要用到一次 findMany(，否则不需要白名单',
    ).toBe(true)
    expect(code.includes('take:'), '白名单成立的前提是分页（带 take），不是全表扫描').toBe(true)
  })
})
