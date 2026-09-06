import { useSyncExternalStore } from 'react'

import type { KVStore } from './secureStore'

/** 会话快照。`data` 是调用方自定义的登录态载荷（会员信息 / 员工信息 + 当前店）。 */
export interface SessionState<T> {
  token: string | null
  data: T | null
  /** 是否已完成一次本地存储的读取——启动瞬间是 `false`，据此画启动屏而不是「未登录」。 */
  ready: boolean
}

/** {@link createSessionStore} 返回的会话控制器。 */
export interface SessionStore<T> {
  getState(): SessionState<T>
  subscribe(listener: () => void): () => void
  /** 冷启动时调一次：把 SecureStore 里的旧会话读回内存。 */
  hydrate(): Promise<void>
  /** 登录成功后调：同时更新内存态（同步生效）与持久化（异步落盘）。 */
  save(token: string, data: T): Promise<void>
  /** 401 或主动登出时调：清内存态与持久化。 */
  clear(): Promise<void>
  /** 组件里用：`const { token, data, ready } = store.useSession()`。 */
  useSession(): SessionState<T>
}

const INITIAL_STATE = { token: null, data: null, ready: false } as const

/**
 * 建一个按 `storageKey` 落盘的会话存储（蓝图 §5.4）。两个 App 各建一个：
 * 学员端存会员 token，商家端存 staff token + 当前店；形状不同所以用泛型 `T`，
 * 而不是在 `@taizan/app-ui` 里写死一份「会话」形状。
 *
 * `storage` 必须由调用方传入（通常是 `secureStore`）——这里只依赖 {@link KVStore}
 * 这个纯接口的类型，不在模块顶层 `import` 真实的 `secureStore.ts`（它会拉 `react-native`），
 * 这样 vitest（node 环境，没接 RN 的 jest 预设）才能直接测这个文件。
 */
export function createSessionStore<T>(storageKey: string, storage: KVStore): SessionStore<T> {
  let state: SessionState<T> = INITIAL_STATE
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((listener) => listener())

  function getState(): SessionState<T> {
    return state
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function hydrate(): Promise<void> {
    const raw = await storage.get(storageKey)
    if (!raw) {
      state = { ...INITIAL_STATE, ready: true }
      emit()
      return
    }
    try {
      const parsed = JSON.parse(raw) as { token: string; data: T }
      state = { token: parsed.token, data: parsed.data, ready: true }
    } catch {
      // 存储内容损坏（旧版本遗留的不兼容形状等）——当没登录处理，不让启动直接崩溃。
      state = { ...INITIAL_STATE, ready: true }
    }
    emit()
  }

  async function save(token: string, data: T): Promise<void> {
    state = { token, data, ready: true }
    emit()
    await storage.set(storageKey, JSON.stringify({ token, data }))
  }

  async function clear(): Promise<void> {
    state = { ...INITIAL_STATE, ready: true }
    emit()
    await storage.remove(storageKey)
  }

  function useSession(): SessionState<T> {
    return useSyncExternalStore(subscribe, getState, getState)
  }

  return { getState, subscribe, hydrate, save, clear, useSession }
}
