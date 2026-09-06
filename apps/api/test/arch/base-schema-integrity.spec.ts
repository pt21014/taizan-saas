/**
 * 蓝图 §8 **spec 15**：`prisma/schema/00-base/**` 的 sha256 与 `base.lock.json` 一致。
 *
 * 守的不变量：**手改框架 schema 片段导致升级冲突**。
 *
 * Prisma 不能从 `node_modules` include 片段，所以框架的表结构必须真的**拷贝**进项目仓库
 * （`taizan:schema-sync`）。拷进去的东西就会被人改——本地临时加一列、跑通了、忘了；
 * 半年后升级框架，`schema-sync` 把那一列冲掉，migrate 生成一条 `DROP COLUMN`。
 *
 * lock 文件让这件事在**改的当天**就变红，而不是在升级的那天。
 *
 * 校验逻辑一行都不重写，全部委托给 `@taizan/prisma-base` 的 `checkSchemaSync`——
 * 「什么算一致」只能有一份定义（它比对三件事：片段内容、lock 版本、lock 里记的 hash）。
 */

import {
  BASE_LOCK_FILE_NAME,
  BASE_SCHEMA_FILES,
  checkSchemaSync,
  MANAGED_FILE_BANNER,
  PRISMA_BASE_VERSION,
} from '@taizan/prisma-base'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { frameworkSchemaDir, SCHEMA_DIR } from './_helpers'

const result = checkSchemaSync(SCHEMA_DIR, frameworkSchemaDir())

describe('spec 15：框架 schema 片段的完整性', () => {
  it('lock 文件存在', () => {
    expect(existsSync(join(SCHEMA_DIR, BASE_LOCK_FILE_NAME))).toBe(true)
  })

  it('片段内容 / lock 版本 / lock 里的 sha256 三者一致', () => {
    const detail = result.diffs.map((d) => `  [${d.kind}] ${d.file}：${d.detail}`).join('\n')
    expect(
      result.ok,
      `00-base/ 与 @taizan/prisma-base@${PRISMA_BASE_VERSION} 对不上：\n${detail}\n\n` +
        '· 手改了框架片段 → 把改动挪到 10-business/，或者提 issue 改框架；\n' +
        '· 刚升级了框架版本 → 跑 `pnpm -F @taizan/api taizan:schema-sync` 并 review diff。',
    ).toBe(true)
  })

  it('9 个框架片段一个不少', () => {
    const base = join(SCHEMA_DIR, '00-base')
    const actual = readdirSync(base)
      .filter((f) => f.endsWith('.prisma'))
      .sort()
    expect(actual).toEqual([...BASE_SCHEMA_FILES].sort())
  })

  it('每个框架片段都带「勿手改」横幅', () => {
    // 横幅是给人看的第一道防线：review diff 时一眼能看出「这文件不归我改」。
    const base = join(SCHEMA_DIR, '00-base')
    for (const name of BASE_SCHEMA_FILES) {
      const text = readFileSync(join(base, name), 'utf8')
      expect(text, `${name} 少了托管横幅`).toContain(MANAGED_FILE_BANNER)
    }
  })

  it('业务片段放在 10-business/，不在 00-base/ 里', () => {
    const business = readdirSync(join(SCHEMA_DIR, '10-business')).filter((f) =>
      f.endsWith('.prisma'),
    )
    expect(business.length, '10-business/ 里一个业务片段都没有？').toBeGreaterThan(0)
    // 反过来：`00-base/` 里不许有框架清单之外的 `.prisma`。
    // 放进去的话下次 `schema-sync` 会把它删掉（那是 sync 的正确行为）。
    const strays = readdirSync(join(SCHEMA_DIR, '00-base'))
      .filter((f) => f.endsWith('.prisma'))
      .filter((f) => !(BASE_SCHEMA_FILES as readonly string[]).includes(f))
    expect(strays, '这些文件放错地方了，业务片段请放 10-business/').toEqual([])
  })

  it('迁移历史不在 00-base/ 里', () => {
    // Prisma 默认把 migrations 放在「含 datasource 的那个片段」旁边，也就是 `00-base/`。
    // 那是框架托管目录，`schema-sync` 会覆盖它。`prisma.config.ts` 里的 `migrations.path`
    // 把迁移挪到了 `prisma/migrations`；这条断言盯着那个配置别被改回去。
    expect(existsSync(join(SCHEMA_DIR, '00-base', 'migrations'))).toBe(false)
    expect(existsSync(join(SCHEMA_DIR, '..', 'migrations'))).toBe(true)
  })
})
