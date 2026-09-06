import { defineConfig } from 'tsup'

/**
 * 生成器打成单文件 ESM：`pnpm create taizan-saas` 会 `npx` 下载本包后直接执行 bin，
 * 那个环境里没有 tsx、也没有 workspace，入口必须是能被 node 直接跑的 .js。
 *
 * `templates/` 不进 bundle——它是数据不是代码，通过 package.json 的 `files` 随包发布，
 * 运行时用 `import.meta.url` 定位（见 src/paths.ts）。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
})
