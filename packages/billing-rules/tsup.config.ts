import { defineConfig } from 'tsup'

// 照抄 packages/_smoke/tsup.config.ts：ESM + CJS 双格式 + d.ts，只有 entry 按需增删。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
