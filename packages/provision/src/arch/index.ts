/**
 * `@taizan/provision/arch` —— **node-only** 的架构测试扫描器子入口。
 *
 * ## 为什么要单独开一个子入口
 *
 * 主入口 `@taizan/provision`（`src/index.ts`）只导出浏览器可用的纯规则
 * （`validateSlug` / `normalizePhone` / `assertOwnerPasswordPolicy` / `RESERVED_SLUGS` /
 * 各种类型……）——它们不 import 任何 node 内置模块，`vite dev` 原生 ESM 加载也不会炸。
 *
 * `scanTenantCreateCalls()`（spec 14 的扫描器）顶层 `import { readdirSync } from 'node:fs'`，
 * 只给 vitest（跑在 node 进程里的架构测试）用。曾经这两类导出挤在同一个 `dist/index.js` 里：
 * `vite build` 能靠 Rollup 的 tree-shaking + external 绕过去，但 `vite dev` 走原生 ESM、
 * 无条件求值整个模块——浏览器请求这个文件时，`import ... from 'fs'` 落到 Vite 的浏览器
 * 兼容桩对象上，一访问属性就抛错，整页 React 挂载失败（白屏）。`apps/site` 曾经因此被迫
 * 在构建期生成一份纯数据文件绕过（见该应用 README「关键坑」，现已改回直接 import 主入口）。
 *
 * 现在拆成两个 tsup 入口（`splitting: true`，见 `tsup.config.ts` 与
 * `scripts/check-dist-identity.mjs`）：主入口 `dist/index.js` 里不会再出现任何
 * `node:fs`/`node:path` 字样，浏览器可以放心 `import from '@taizan/provision'`；
 * 测试代码（`apps/api/test/arch/*`）改成 `import from '@taizan/provision/arch'`。
 *
 * @packageDocumentation
 */

export {
  DEFAULT_ALLOWLIST,
  SENTINEL_EXPECTATION,
  SENTINEL_SOURCE,
  readSourceFiles,
  scanTenantCreateCalls,
  stripCommentsAndStrings,
  type ScanInput,
  type SinglePathReport,
  type SinglePathViolation,
  type SourceFile,
  type TenantCreateCall,
  type TenantWriteKind,
} from './single-path.scan'
