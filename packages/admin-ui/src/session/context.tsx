import { createContext, useContext, type ReactNode } from 'react'
import type { SessionState, SessionStore } from './store'

const SessionContext = createContext<SessionStore | null>(null)

/**
 * 把一份 `createSessionStore()` 的实例注入给子树。`apps/admin`/`apps/platform` 各自
 * 创建一份不同配置（`baseURL`/`storageKeyPrefix`）的 store，套一层 `<SessionProvider>`
 * 就能让 admin-ui 内置的全部组件（`<AppShell>`/`<LoginPage>`/`<ShopSwitcher>`/...）
 * 复用同一套会话状态，不用各自再传一遍 store 引用。
 */
export function SessionProvider({ store, children }: { store: SessionStore; children: ReactNode }) {
  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>
}

/**
 * 读取会话状态的唯一入口。所有 admin-ui 内置组件都通过它取数据——直接引用某个具体
 * store 实例的话，同一个组件就没法同时给 `apps/admin`（商家）与 `apps/platform`
 * （平台超管）复用。
 */
export function useSession<T>(selector: (state: SessionState) => T): T {
  const store = useContext(SessionContext)
  if (!store) {
    throw new Error('[@taizan/admin-ui] useSession() 必须包在 <SessionProvider store={...}> 内使用')
  }
  return store(selector)
}
