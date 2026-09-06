import { defineConfig } from 'tsup'

// 统一构建方式：ESM + CJS 双格式 + d.ts。后续所有 packages/* 都用这份配置的形状，
// 只需要按需增删 entry。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
