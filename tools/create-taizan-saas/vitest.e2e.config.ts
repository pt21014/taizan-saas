import { defineConfig } from 'vitest/config'

/**
 * 生成器的**验收 e2e**（蓝图 §6 的 9 条）。
 *
 * 与 `vitest.config.ts`（`test/**`，纯文件操作、不装依赖不联网）分开的理由很直接：
 * 这一份要真的生成项目、真的 `pnpm install`、真的连 MySQL + Redis、真的起一个 api 子进程，
 * 单机跑一趟以分钟计。把它混进 `pnpm test` 会让「改一行渲染逻辑」也要等十几分钟。
 *
 * - `fileParallelism: false` + 单线程：全程只有一个生成项目、一个库、一个端口；
 * - `hookTimeout` 给到 40 分钟：`beforeAll` 里包含 `pnpm pack`×26 + `pnpm install` + 迁移 + 构建；
 * - `testTimeout` 60s：单条断言只是一两个 HTTP 请求，超过 60s 一定是别的地方出事了。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.spec.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 2_400_000,
    teardownTimeout: 120_000,
    poolOptions: { threads: { singleThread: true } },
    // 9 条断言有先后依赖（②建出来的租户是⑦的对照组，⑧改的到期时间是⑨要续的）。
    // 任一条红掉，后面的断言只会产生噪音——所以第一条红就停。
    bail: 1,
    reporters: ['verbose'],
  },
})
