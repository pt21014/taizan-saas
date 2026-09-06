import { defineConfig } from 'tsup'

// 形状照抄 packages/_smoke/tsup.config.ts：ESM + CJS 双格式 + d.ts。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
