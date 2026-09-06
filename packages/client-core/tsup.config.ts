import { defineConfig } from 'tsup'

// 形状照抄 packages/_smoke：ESM + CJS 双格式 + d.ts。
// `@tarojs/taro` 与 `react` 是 peer，不打进产物——四端各自的宿主环境已经提供它们。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['@tarojs/taro', 'react'],
})
