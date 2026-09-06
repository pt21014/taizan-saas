import { defineConfig, devices } from '@playwright/test'

/**
 * e2e 需要**真实后端**（蓝图 §3.2 说的「不 mock 网络层」）：
 *
 * ```bash
 * pnpm dev:infra
 * pnpm -F @taizan/api prisma:migrate
 * pnpm -F @taizan/api seed
 * pnpm -F @taizan/api dev
 * ```
 *
 * 起好后端后再跑 `pnpm -F @taizan/admin e2e`——这里的 `webServer` 只负责拉起
 * `apps/admin` 自己（`vite dev`），不负责拉起后端，也不 mock 它。
 *
 * 后端默认端口 3000；本机 3000 被占（比如同时在跑另一份 `apps/api`）时，
 * 把后端起在别的端口，跑 e2e 前设 `API_PROXY_TARGET=http://localhost:<端口>`，
 * 这里会原样透传给 `vite.config.ts` 的代理配置。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  // 本地联调后端偶发因并发改代码触发 tsx watch 重启（几秒钟的 ECONNREFUSED 窗口），
  // 与这几条用例本身无关；重试一次即可穿过这种瞬时抖动。
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30_000,
    env: process.env.API_PROXY_TARGET ? { API_PROXY_TARGET: process.env.API_PROXY_TARGET } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
