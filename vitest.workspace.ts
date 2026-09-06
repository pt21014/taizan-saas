import { defineWorkspace } from 'vitest/config'

// 每个 package/app 各自维护一份 vitest.config.ts，这里只负责把它们汇总成一个工作区，
// 方便在仓库根目录用 `pnpm exec vitest` 跑全仓测试或打开 vitest UI。
// CI/turbo 走的是各 package 自己的 `test` script（`vitest run`），不依赖这个文件。
export default defineWorkspace([
  'packages/*/vitest.config.ts',
  'apps/*/vitest.config.ts',
  'tools/*/vitest.config.ts',
])
