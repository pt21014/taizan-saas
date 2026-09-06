import { defineConfig } from 'vitest/config'

/**
 * `pnpm test` 跑的范围：**纯单测 + 架构约束 spec，一律不连库**。
 * 隔离 e2e 要真 MySQL/Redis，单独一份 `vitest.e2e.config.ts`（`pnpm test:e2e`）。
 *
 * 分开的理由：CI 的 lint/test 阶段不该依赖数据库容器起没起来；
 * 而架构 spec（蓝图 §8）恰恰是最该在每次提交都跑的那一批。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/arch/**/*.spec.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
    },
  },
})
