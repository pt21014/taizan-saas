import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // CI runner 冷启动时 jsdom 首次渲染较慢（本地 Windows 只需几百毫秒），
    // 不是用例逻辑问题，统一在配置层放宽超时，避免逐用例加 { timeout }。
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
