import { defineConfig } from 'tsup'

// 两个入口：库本体 + 轮换 CLI。CLI 单独成入口，既能 `node dist/cli/rotate-key.js` 直接跑，
// 也能被 spec import 里面的纯函数做断言。
export default defineConfig({
  entry: ['src/index.ts', 'src/cli/rotate-key.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
