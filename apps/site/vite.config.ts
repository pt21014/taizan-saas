import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * `apps/site` 是平台自己的官网：11 页营销站 + 自助注册表单，**零 UI 库**——
 * 营销页长成后台的样子就不像官网了，也没有 AntD 那种重组件树要装配。
 *
 * dev server 固定 5176（`apps/admin` 用 5173、`apps/platform` 用 5175，
 * 三个前端不该抢端口）；`/api` 代理到 `apps/api` 的 3000，路径里已经带完整的
 * `/api/public/...` 前缀，`src/api.ts` 里的 baseURL 留空即可。
 *
 * 生产部署与 API **同域**（nginx 把 `/api/` 反代过去，见 README「同域部署」一节），
 * 所以生产构建不需要另配一个 `VITE_API_BASE`——这是与 apps/admin/apps/platform
 * 唯一的差异：那两个后台的 API 服务器可能跨域，官网不会。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
