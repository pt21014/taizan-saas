import { defineConfig } from 'vitest/config'

// 只测纯逻辑（transport 剥包 / 错误分流 / session 存取 / tokens 键完整性），
// 不拉 react-native 的 jest 预设——那套很重，且这一层没有需要挂载渲染的用例。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'lcov'],
    },
  },
})
