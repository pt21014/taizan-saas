import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { mockAdminApi } from './mock-plugin'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// demo/ 不是独立 workspace 包（只是 @taizan/admin-ui 的最小演示应用，不进 dist），
// 所以 `@taizan/admin-ui` 这个 specifier 不会被 pnpm 链到 node_modules——直接别名到
// 源码入口，改包代码不用先 build 就能在 demo 里立刻看到效果。
export default defineConfig({
  root: here('.'),
  plugins: [react(), mockAdminApi()],
  resolve: {
    alias: {
      '@taizan/admin-ui': here('../src/index.ts'),
    },
  },
  server: {
    port: 5174,
  },
  build: {
    outDir: here('dist'),
    emptyOutDir: true,
  },
})
