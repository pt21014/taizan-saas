import { defineConfig } from 'tsup'

// 两个入口：库本体（index）与 schema 校验 CLI。CLI 单独成一个入口是为了让项目侧
// 既能 `node dist/cli/verify-schema.js` 直接跑，也能 import 它的纯函数写自己的 spec。
export default defineConfig({
  entry: ['src/index.ts', 'src/cli/verify-schema.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
