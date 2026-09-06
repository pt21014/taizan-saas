import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * `apps/admin` 是一个普普通通的 Vite 6 + React 18 SPA，装配 `@taizan/admin-ui`
 * （不像 admin-ui 的 demo 那样把包别名到源码——这里跑的是真实的 workspace 依赖，
 * 改 `packages/admin-ui` 之后要 `pnpm -F @taizan/admin-ui build` 才会在这里生效）。
 *
 * dev server 固定 5173，`/api` 代理到本机的 `apps/api`（默认 3000 端口，
 * 起法见根 README：`pnpm dev:infra && pnpm -F @taizan/api prisma:migrate && pnpm -F @taizan/api seed && pnpm -F @taizan/api dev`）。
 * 生产构建不代理——`VITE_API_BASE` 直接配成真实域名，见 `.env.example`。
 *
 * `API_PROXY_TARGET`：3000 端口被占（比如本机同时在跑另一份 `apps/api`）时，
 * 换个端口起后端，用这个环境变量把代理指过去，不用改这个文件本身。
 * `pnpm -F @taizan/admin e2e` 前 `API_PROXY_TARGET=http://localhost:3060 pnpm -F @taizan/admin dev` 即可。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
