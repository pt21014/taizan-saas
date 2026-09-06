/**
 * 登录态在 `localStorage` 里的存放方式。键名带前缀（默认 `taizan_admin`）——
 * `apps/admin` 与 `apps/platform` 共用这一个包但跑在不同域名/不同 token 语义下，
 * 键名撞在一起的表现是「在 platform 登进去，admin 那个标签页也跟着换了身份」。
 *
 * 所有读写都包一层 try/catch：隐私模式或存储被禁用时不该让整个后台白屏，
 * 只是退化成「每次都要重新登录」。
 */
export interface TokenStorage {
  get(): string | null
  set(token: string): void
  clear(): void
}

export function createTokenStorage(prefix = 'taizan_admin'): TokenStorage {
  const key = `${prefix}_token`
  return {
    get(): string | null {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    set(token: string): void {
      try {
        localStorage.setItem(key, token)
      } catch {
        /* 隐私模式下存不进去，这次会话照常，只是刷新后要重登 */
      }
    },
    clear(): void {
      try {
        localStorage.removeItem(key)
      } catch {
        /* 同上 */
      }
    },
  }
}
