/**
 * 打烊页（`1440302` `ErrorCode.SHOP_CLOSED`）与店铺不可用页（`1240400`
 * `ErrorCode.TENANT_NOT_FOUND`）的路由常量与跳转助手。两者都用 `Taro.reLaunch`——
 * 打烊/店铺不存在不是「多一个页面」，是整个 C 端此刻不可用，必须清空页面栈，
 * 否则用户返回键还能退回到刚才那个已经打不开的页面，反复触发同一个错误请求。
 *
 * `apps/client` 需要把这两个路径真实注册进 `app.config.ts` 的 `pages` 列表；
 * 本模块只提供常量，不假设应用一定用这两个具体路径以外的页面结构。
 *
 * @packageDocumentation
 */

import Taro from '@tarojs/taro'

/** 打烊页路径（套餐到期）。 */
export const CLOSED_PAGE_PATH = '/pages/closed/index'
/** 店铺不可用页路径（slug 解析不出来 / 店铺不存在）。 */
export const TENANT_MISSING_PAGE_PATH = '/pages/tenant-missing/index'

/** 跳打烊页，清空页面栈。 */
export function gotoClosedPage(): void {
  void Taro.reLaunch({ url: CLOSED_PAGE_PATH })
}

/** 跳店铺不可用页，清空页面栈。 */
export function gotoTenantMissingPage(): void {
  void Taro.reLaunch({ url: TENANT_MISSING_PAGE_PATH })
}
