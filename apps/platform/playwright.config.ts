import { defineConfig, devices } from '@playwright/test'

/**
 * e2e 需要**真实后端**（`apps/api` 跑在 3000，MySQL/Redis 由 `pnpm dev:infra` 起，
 * seed 出平台管理员 `admin`/`admin123`）——mock 后端测不出「冻结租户后商家侧立刻 401」
 * 这种跨进程的真实效果。跑之前：
 *
 * ```bash
 * pnpm dev:infra                 # 根目录，起 MySQL(3307)/Redis(6380)
 * pnpm -F @taizan/api prisma:generate && pnpm -F @taizan/api seed
 * pnpm -F @taizan/api dev        # 3000
 * pnpm -F @taizan/platform e2e   # 会自动拉起本应用的 5175（已在跑就复用）
 * ```
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5175',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5175',
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
