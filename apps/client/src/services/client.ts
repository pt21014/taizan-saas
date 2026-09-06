/**
 * 装配 `@taizan/client-core`：request 的 baseURL/token/tenantSlug 钩子、闸门跳转
 * （`1440302` 打烊 / `1240400` 店铺不可用）、401 清态跳登录，全部集中在这一处。
 * 页面代码只应该 `import { request, session } from '../../services/client'`，
 * 不直接碰 `Taro.request` 或 `@tarojs/taro` 的 storage API。
 *
 * @packageDocumentation
 */

import {
  clearMemberToken,
  createClientRequest,
  createSession,
  getMemberToken,
  getStoredTenantSlug,
  gotoClosedPage,
  gotoTenantMissingPage,
  resolveTenantSlug,
} from '@taizan/client-core'
import Taro from '@tarojs/taro'

import { API_BASE, H5_BASE_DOMAIN } from '../config'

let currentTenantSlug: string | null = null

/** 当前已解析的 tenantSlug；未解析出来时回退到上一次持久化的值。 */
export function getTenantSlug(): string | null {
  return currentTenantSlug ?? getStoredTenantSlug()
}

/**
 * 在 `app.tsx` 的 `useLaunch` 里调用一次：解析 tenantSlug（H5 路径/子域名，
 * 小程序启动参数）。返回 `null` 时页面侧应跳店铺不可用页——不要让首页在
 * 「不知道是哪家店」的情况下继续发请求。
 */
export function initTenantSlug(): string | null {
  currentTenantSlug = resolveTenantSlug({ h5BaseDomain: H5_BASE_DOMAIN })
  return currentTenantSlug
}

function toast(message: string): void {
  Taro.showToast({ title: message, icon: 'none' })
}

export const request = createClientRequest({
  baseURL: API_BASE,
  getToken: getMemberToken,
  getTenantSlug,
  onUnauthorized: () => {
    clearMemberToken()
    void Taro.reLaunch({ url: '/pages/login/index' })
  },
  // 1440302：套餐到期，C 端打烊——整页换成打烊页，不是弹 toast
  onClosed: () => gotoClosedPage(),
  // 1240400：slug 解析不出来 / 店铺不存在——整页换成店铺不可用页
  onTenantMissing: () => gotoTenantMissingPage(),
  onForbidden: (error) => toast(error.message),
  onBizError: (error) => toast(error.message),
})

export const session = createSession(request)
