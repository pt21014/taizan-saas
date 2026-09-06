import { describe, expect, it, vi } from 'vitest'

import { createSessionStore } from './useSession'
import type { KVStore } from './secureStore'

function fakeStorage(initial?: string): KVStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  if (initial !== undefined) data.set('session', initial)
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value)
    }),
    remove: vi.fn(async (key: string) => {
      data.delete(key)
    }),
  }
}

interface StaffSession {
  staffId: string
  tenantId: string
}

describe('createSessionStore：会话存取（用 mock KVStore，不碰真实 SecureStore）', () => {
  it('hydrate 之前是未 ready 的空态', () => {
    const store = createSessionStore<StaffSession>('session', fakeStorage())
    expect(store.getState()).toEqual({ token: null, data: null, ready: false })
  })

  it('hydrate 且本地没有会话：ready=true 但仍是空态', async () => {
    const storage = fakeStorage()
    const store = createSessionStore<StaffSession>('session', storage)
    await store.hydrate()
    expect(store.getState()).toEqual({ token: null, data: null, ready: true })
    expect(storage.get).toHaveBeenCalledWith('session')
  })

  it('hydrate 能把上次 save 落盘的会话读回来', async () => {
    const storage = fakeStorage(
      JSON.stringify({ token: 'tok-1', data: { staffId: 's1', tenantId: 't1' } }),
    )
    const store = createSessionStore<StaffSession>('session', storage)
    await store.hydrate()
    expect(store.getState()).toEqual({
      token: 'tok-1',
      data: { staffId: 's1', tenantId: 't1' },
      ready: true,
    })
  })

  it('存储内容损坏（非法 JSON）时当没登录处理，不抛异常', async () => {
    const storage = fakeStorage('{not-json')
    const store = createSessionStore<StaffSession>('session', storage)
    await expect(store.hydrate()).resolves.toBeUndefined()
    expect(store.getState()).toEqual({ token: null, data: null, ready: true })
  })

  it('save 同步更新内存态，并异步落盘', async () => {
    const storage = fakeStorage()
    const store = createSessionStore<StaffSession>('session', storage)
    const promise = store.save('tok-2', { staffId: 's2', tenantId: 't2' })
    // 内存态同步生效——组件不用等 SecureStore 写完才看到新登录态。
    expect(store.getState().token).toBe('tok-2')
    await promise
    expect(storage.set).toHaveBeenCalledWith(
      'session',
      JSON.stringify({ token: 'tok-2', data: { staffId: 's2', tenantId: 't2' } }),
    )
  })

  it('clear 清空内存态并删除持久化', async () => {
    const storage = fakeStorage(
      JSON.stringify({ token: 'tok-3', data: { staffId: 's3', tenantId: 't3' } }),
    )
    const store = createSessionStore<StaffSession>('session', storage)
    await store.hydrate()
    await store.clear()
    expect(store.getState()).toEqual({ token: null, data: null, ready: true })
    expect(storage.remove).toHaveBeenCalledWith('session')
  })

  it('subscribe 在 save/clear 时收到通知，取消订阅后不再收到', async () => {
    const store = createSessionStore<StaffSession>('session', fakeStorage())
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    await store.save('t', { staffId: 's', tenantId: 'x' })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    await store.clear()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
