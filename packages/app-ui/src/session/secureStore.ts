import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

/**
 * SecureStore 键只允许字母数字和 `.-_`（iOS Keychain 的限制），
 * 而我们的键里常有冒号（`taizan_staff_token:<tenantId>`）——不洗的话在原生上直接抛错，
 * 且错误信息完全不会指向「键里有个冒号」这件事。纯函数，单独导出以便不依赖 RN 就能测。
 */
export function sanitizeSecureStoreKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_')
}

function webStorage(): Storage | null {
  return typeof globalThis !== 'undefined' && 'localStorage' in globalThis
    ? (globalThis as unknown as { localStorage: Storage }).localStorage
    : null
}

/** 键值存取的最小接口，`useSession.ts` 与两个 App 的登录态都只依赖这一层。 */
export interface KVStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * token 的存放处（蓝图 §5.4）。
 *
 * **原生上用 SecureStore**（iOS Keychain / Android Keystore）：token 就是用户身份，
 * 明文落盘在越狱/root 过的机器上等于没锁。**web 上 `expo-secure-store` 是空实现**，
 * 调用会直接抛错，而 `expo export --platform web` 正是本任务验收要跑的通道之一，
 * 所以 web 回落到 `localStorage`——不发布 web 端时这是可接受的取舍，真要发布 web
 * 这一条必须重新设计（同源脚本都读得到）。
 */
export const secureStore: KVStore = {
  async get(key) {
    const k = sanitizeSecureStoreKey(key)
    try {
      if (Platform.OS === 'web') return webStorage()?.getItem(k) ?? null
      return await SecureStore.getItemAsync(k)
    } catch {
      // 读不出来就当没登录——比让整个 App 卡在启动页好。
      return null
    }
  },

  async set(key, value) {
    const k = sanitizeSecureStoreKey(key)
    try {
      if (Platform.OS === 'web') {
        webStorage()?.setItem(k, value)
        return
      }
      await SecureStore.setItemAsync(k, value)
    } catch {
      // 写不进去不能让登录失败：代价只是下次冷启动要重登，而不是接口明明成功了
      // 界面却还停在登录页、没有任何解释。
    }
  },

  async remove(key) {
    const k = sanitizeSecureStoreKey(key)
    try {
      if (Platform.OS === 'web') {
        webStorage()?.removeItem(k)
        return
      }
      await SecureStore.deleteItemAsync(k)
    } catch {
      // 忽略：删不掉最坏情况是留了一条过期 token，下次请求 401 时仍会被清一次。
    }
  },
}
