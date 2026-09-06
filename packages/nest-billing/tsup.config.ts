import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Nest 装饰器需要 legacy decorators；tsup 会读取 tsconfig.json 的 experimentalDecorators。
  target: 'node22',
})
