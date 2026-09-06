import { defineConfig } from 'tsup'

// 三个入口：库本体 + 两个 CLI。CLI 单独成入口，既能 `node dist/cli/sync.js` 直接跑，
// 也能被 spec import 里面的纯函数做断言。schema/*.prisma 不进 dist，随包原样发布。
export default defineConfig({
  entry: ['src/index.ts', 'src/cli/sync.ts', 'src/cli/verify.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
