import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // 装饰器 + AsyncLocalStorage 的集成测试之间会共享模块级单例（ALS、pino 实例），
    // 用单线程 fork 跑，避免并发 worker 之间互相污染 process.env。
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: { reporter: ['text', 'lcov'] },
  },
  esbuild: {
    target: 'node22',
  },
})
