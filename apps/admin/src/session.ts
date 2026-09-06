import { createSessionStore } from '@taizan/admin-ui'

/**
 * `baseURL` 留空时走 `vite.config.ts` 的 `/api` 代理（本机开发）；生产构建时
 * `VITE_API_BASE` 填真实后端地址。`storageKeyPrefix` 与 `apps/platform` 不同，
 * 避免两个后台在同一浏览器 profile 下互相踩 localStorage 键。
 */
export const useSession = createSessionStore({
  baseURL: import.meta.env.VITE_API_BASE || '',
  storageKeyPrefix: 'admin',
})
