import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'arch/index': 'src/arch/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // 两个入口（`src/index.ts` 与 `src/arch/index.ts`）如果将来出现共享模块，
  // 必须被抽成同一份 chunk，两个入口各自 require/import 它——否则 esbuild 会把
  // 共享代码分别复制进两份产物，跨入口拿到的就是两个不同的引用。见
  // `@taizan/nest-prisma`/`@taizan/nest-infra` 的同名注释与
  // `scripts/check-dist-identity.mjs`（照抄它的方案）。
  //
  // 本包现状：`src/index.ts` 不再 import/re-export `src/arch/**` 的任何一行
  // （这正是这次拆分的目的——两个入口在源码层面就没有交叉），所以今天 `splitting`
  // 开不开都不影响 `dist/index.js` 里出现 `node:fs`：只要 `index.ts` 没有依赖它，
  // esbuild 就不会把它打进去。仍然开 `splitting: true` 是为了和仓库里其他多入口
  // 包保持同一套构建约定，往后谁在 `src/index.ts` 里手滑 re-export 了
  // `arch/single-path.scan.ts` 的符号，`check-dist-identity.mjs` 的
  // node-builtin-free 断言会立刻抓到。
  splitting: true,
  target: 'node22',
})
