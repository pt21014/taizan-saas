import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // 守卫/拦截器的集成测试共享模块级单例（ALS、reflect-metadata 注册表），
    // 用单线程 fork 跑，避免并发 worker 之间互相污染。
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: { reporter: ['text', 'lcov'] },
  },
  esbuild: {
    target: 'node22',
  },
})
