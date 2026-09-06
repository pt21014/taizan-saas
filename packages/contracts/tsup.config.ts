import { defineConfig } from 'tsup'

// 照抄 packages/_smoke 的构建形状：ESM + CJS 双格式 + d.ts。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
