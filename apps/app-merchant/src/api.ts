import { createApiClient, toast } from '@taizan/app-ui'
import Constants from 'expo-constants'
import { router } from 'expo-router'

import { sessionStore } from './session'

interface MerchantExtra {
  apiBase?: string
}

const extra = (Constants.expoConfig?.extra ?? {}) as MerchantExtra

/** 同 app-client 的取值顺序：env 覆盖 `app.json` 的 `extra`，都不给时留空（不写死域名兜底）。 */
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE?.trim() || extra.apiBase || ''

/**
 * 商家端**没有 `X-Tenant-Slug`**：staff token 里就带着 `tenantId`，且一次只绑一家店
 * （蓝图 §4.3 的不变量）——换店是向 `/admin/auth/switch` 换一张新 token，不是让一张
 * token 通吃名下所有店，所以这里不需要也不该给 `getTenantSlug`。
 */
export const api = createApiClient(API_BASE, {
  getToken: () => sessionStore.getState().token,
  onUnauthorized: () => {
    void sessionStore.clear()
    router.replace('/login')
  },
  onShopClosed: () => {
    // `1440302` 是 C 端打烊码，staff token 理论上不会触发；留一个兜底提示而不是导航。
    toast.show('店铺当前不可用', 'error')
  },
  onForbidden: (message) => toast.show(message),
  onBizError: (message) => toast.show(message, 'error'),
})
