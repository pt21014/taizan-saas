import { defineConfig } from 'vitest/config'

/**
 * 生成器的单测**不装依赖、不联网**：渲染、裁剪、manifest 一致性都是纯文件操作，
 * 在临时目录里跑完即弃。真的「装依赖 + 编译」那一层是 `pnpm create:demo`
 * （仓库根 scripts/create-demo.mjs）与 CI 的 generator-e2e.yml，不在这里。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 60_000,
  },
})
