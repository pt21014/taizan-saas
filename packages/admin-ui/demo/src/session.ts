import { createSessionStore } from '@taizan/admin-ui'

// baseURL 留空：demo 的 mock 后端（见 ../mock-plugin.ts）挂在 Vite dev server 同源下的
// /api/admin/auth/* 上，不需要跨域前缀。
export const useSession = createSessionStore({ baseURL: '', storageKeyPrefix: 'demo_admin' })
