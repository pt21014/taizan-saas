import { defineConfig } from 'tsup'

// 照抄 packages/_smoke/tsup.config.ts 的形状：ESM + CJS + d.ts，单入口。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
