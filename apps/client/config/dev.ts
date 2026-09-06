import type { UserConfigExport } from '@tarojs/cli'

/**
 * 本地开发覆盖项。`TARO_APP_API_BASE` 未设置时兜底走 `/api`（配 `devServer.proxy`
 * 反代到本地 `apps/api`），这样本地起两个终端（`pnpm -F api dev` + `pnpm -F @taizan/client
 * dev:h5`）就能联调，不需要每次手写完整域名。
 */
export default {
  logger: {
    quiet: false,
    stats: true,
  },
  mini: {},
  h5: {
    devServer: {
      port: 10086,
      proxy: {
        '/api': {
          target: process.env.TARO_APP_DEV_PROXY_TARGET ?? 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  },
} satisfies UserConfigExport<'webpack5'>
