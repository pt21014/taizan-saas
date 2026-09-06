import { describe, expect, it, vi } from 'vitest'

import { createToastStore } from './Toast'

describe('createToastStore：纯逻辑队列，不依赖 RN', () => {
  it('show 后 getState 能读到这条消息', () => {
    const store = createToastStore()
    store.show('已保存')
    expect(store.getState()?.text).toBe('已保存')
    expect(store.getState()?.tone).toBe('default')
  })

  it('到期后自动清空，并通知订阅者', () => {
    vi.useFakeTimers()
    try {
      const store = createToastStore()
      const listener = vi.fn()
      store.subscribe(listener)
      store.show('出错了', 'error', 1000)
      expect(store.getState()?.tone).toBe('error')
      vi.advanceTimersByTime(1000)
      expect(store.getState()).toBeNull()
      expect(listener).toHaveBeenCalledTimes(2) // 出现一次、消失一次
    } finally {
      vi.useRealTimers()
    }
  })

  it('show 返回的取消函数能在到期前主动撤销', () => {
    vi.useFakeTimers()
    try {
      const store = createToastStore()
      const cancel = store.show('稍后可见', 'default', 5000)
      cancel()
      expect(store.getState()).toBeNull()
      vi.advanceTimersByTime(5000)
      expect(store.getState()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('后一条覆盖前一条（同一时刻只显示一条）', () => {
    const store = createToastStore()
    store.show('第一条')
    store.show('第二条')
    expect(store.getState()?.text).toBe('第二条')
  })
})
