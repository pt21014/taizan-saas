import { createApiClient } from '@taizan/app-ui'
import type { BootstrapResponse } from '@taizan/contracts'

import { API_BASE } from './api'
import { sessionStore } from './session'

/**
 * 登录/换店拿到新 token 后，用这张 token 直接拉一次 `/admin/auth/bootstrap` 再落盘。
 *
 * 不复用全局 `api`：它的 `getToken` 读 `sessionStore`，而此刻这张新 token 还没存进去——
 * 会出现「手上有 token 却打不进去」的先有鸡先有蛋问题。建一次性客户端更干净，
 * 也不需要额外的可变全局状态。
 */
export async function bootstrapAndSave(token: string): Promise<BootstrapResponse> {
  const oneOff = createApiClient(API_BASE, {
    getToken: () => token,
    // 刚登录就 401，只可能是服务端签名/时钟问题，不是「会话过期」——不清态，原样抛出去。
    onUnauthorized: () => {},
    onShopClosed: () => {},
  })
  const bootstrap = await oneOff.get<BootstrapResponse>('/admin/auth/bootstrap')
  await sessionStore.save(token, { bootstrap })
  return bootstrap
}
