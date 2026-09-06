import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // schema.spec.ts 要起子进程跑 `prisma validate`，比纯函数用例慢一截。
    testTimeout: 120_000,
    coverage: {
      reporter: ['text', 'lcov'],
    },
  },
})
