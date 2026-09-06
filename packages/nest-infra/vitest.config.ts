import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // 锁 TTL / watchdog / cron tick 这些用例本身就要等真实时间，默认 5s 不够。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      reporter: ['text', 'lcov'],
    },
  },
})
