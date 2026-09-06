/**
 * 纯逻辑的 toast 队列，刻意不 import 任何 `react-native` 符号——
 * 这样 vitest（node 环境，没有 RN 的 jest 预设）能直接测这部分，
 * 渲染交给同目录的 `ToastHost.tsx`。
 */
export interface ToastMessage {
  id: number
  text: string
  tone: 'default' | 'error'
}

export interface ToastStore {
  getState(): ToastMessage | null
  subscribe(listener: () => void): () => void
  /** 一次只显示一条，后来的覆盖还没消失的那条；返回值可在到期前主动撤销。 */
  show(text: string, tone?: ToastMessage['tone'], durationMs?: number): () => void
}

export function createToastStore(): ToastStore {
  let current: ToastMessage | null = null
  let nextId = 1
  const listeners = new Set<() => void>()
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  const emit = () => listeners.forEach((l) => l())

  return {
    getState: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    show(text, tone = 'default', durationMs = 2400) {
      const id = nextId++
      current = { id, text, tone }
      emit()
      const timer = setTimeout(() => {
        if (current?.id === id) {
          current = null
          emit()
        }
        timers.delete(id)
      }, durationMs)
      timers.set(id, timer)
      return () => {
        const t = timers.get(id)
        if (t) clearTimeout(t)
        if (current?.id === id) {
          current = null
          emit()
        }
      }
    },
  }
}

/** 单例队列，两个 App 各自 import 一次即可全局共用；测试请用 `createToastStore()` 建独立实例。 */
export const toast = createToastStore()
