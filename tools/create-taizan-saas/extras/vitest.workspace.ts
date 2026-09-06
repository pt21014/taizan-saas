import { defineWorkspace } from 'vitest/config'

// 每个 app 各自维护一份 vitest.config.ts，这里只负责把它们汇总成一个工作区，
// 方便在仓库根目录用 `pnpm exec vitest` 跑全仓测试或打开 vitest UI。
// CI/turbo 走的是各 app 自己的 `test` script（`vitest run`），不依赖这个文件。
//
// 与框架仓库的差别：这里没有 `packages/*`——框架包是从 npm 装的，不在本仓库里。
export default defineWorkspace(['apps/*/vitest.config.ts', 'tools/*/vitest.config.ts'])
