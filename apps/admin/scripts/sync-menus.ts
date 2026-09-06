/**
 * `pnpm -F @taizan/admin sync-menus` —— 把 `apps/api/src/registry/menus.ts` 的
 * `ADMIN_MENUS` 导出成 `src/routes/__fixtures__/admin-menus.json`，供
 * `component-map.spec.ts`（蓝图 §8 spec 7）当真源比对。
 *
 * `apps/api` 不是一个可以 `workspace:*` 依赖的共享包（它是唯一后端进程，不对外发布），
 * 所以这里用**相对路径**直接 import 它的注册表源文件，而不是走 pnpm 的包解析。
 * `registry/menus.ts` 本身只依赖 `@taizan/contracts`（纯数据函数，零 Nest 装饰器），
 * 用 `tsx` 直接跑得起来，不需要先编译整个 `apps/api`。
 *
 * 这是一份**只读脚本**：只导出 JSON 快照，不改 `apps/api` 的任何文件。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADMIN_MENUS } from '../../api/src/registry/menus'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const outFile = here('../src/routes/__fixtures__/admin-menus.json')

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify(ADMIN_MENUS, null, 2) + '\n', 'utf8')

process.stdout.write(
  `已导出 ${ADMIN_MENUS.length} 条顶层菜单（含子节点）到 ${outFile}\n` +
    '若这份快照与 component-map.spec.ts 里的哨兵名单对不上，先看是哪一边落后了。\n',
)
