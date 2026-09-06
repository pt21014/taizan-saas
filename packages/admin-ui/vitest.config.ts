import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // CI runner 冷启动时 AntD + jsdom 的首次渲染很慢（本地 Windows 只需几百毫秒，
    // Linux CI runner 上可能超过 vitest 默认的 5000ms），不是用例逻辑问题，
    // 统一在配置层放宽超时，避免给每个渲染用例单独加 { timeout }。
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      reporter: ['text', 'lcov'],
    },
  },
})
