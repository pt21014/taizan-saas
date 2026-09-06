import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // 两个入口（`src/index.ts` 与 `src/testing/index.ts`）共享的模块必须被抽成同一份
  // chunk，两个入口各自 require/import 它——否则 esbuild 会把共享代码分别复制进
  // 两份产物，跨入口拿到的就是两个不同的 class 引用（本包真实存在这个情况：
  // `InMemoryAuthRedis` / `takeOnce` / `systemClock` 两个入口都直接 re-export）。
  // 见 `@taizan/nest-infra` 的同名注释与 `scripts/check-dist-identity.mjs`（照抄它的方案）。
  splitting: true,
  // Nest 装饰器需要 legacy decorators；tsup 会读取 tsconfig.json 的 experimentalDecorators。
  target: 'node22',
})
