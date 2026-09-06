import { defineConfig } from 'vitest/config'

// component-map.spec.ts 是纯数据对账（verifyComponentMap 不碰 DOM），不需要 jsdom；
// 保留 node 环境更快，也避免为了一条 spec 拉一份 testing-library 依赖。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.{ts,tsx}'],
  },
})
