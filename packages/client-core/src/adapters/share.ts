/**
 * 跨端分享适配：小程序原生支持右上角菜单转发（`onShareAppMessage`），这里只负责
 * `Taro.showShareMenu` 打开转发入口 + 提供分享文案给页面的生命周期钩子用；H5 没有
 * 小程序那种系统级转发面板，能力上限是「复制链接」，这里降级成写剪贴板 + 返回状态，
 * 页面自己决定弹什么提示。
 *
 * @packageDocumentation
 */

import Taro from '@tarojs/taro'

/** 分享内容：标题 + 小程序页面路径（或 H5 完整链接）+ 可选封面图。 */
export interface ShareParams {
  title: string
  path: string
  imageUrl?: string
}

/** {@link share} 的返回结果。`via` 说明实际走了哪条能力。 */
export type ShareResult =
  | { ok: true; via: 'wechat-menu' }
  | { ok: true; via: 'clipboard'; url: string }
  | { ok: false; reason: 'unsupported'; message: string }

/**
 * 统一签名：小程序打开系统转发菜单（真正的转发内容仍需页面在
 * `onShareAppMessage` 里返回 `buildShareConfig()` 的结果，微信不允许脚本直接发起转发）；
 * H5 把可分享链接写入剪贴板。
 */
export async function share(params: ShareParams): Promise<ShareResult> {
  if (process.env.TARO_ENV === 'weapp') {
    await Taro.showShareMenu({ withShareTicket: true })
    return { ok: true, via: 'wechat-menu' }
  }
  return shareViaH5(params)
}

async function shareViaH5(params: ShareParams): Promise<ShareResult> {
  const url = buildH5ShareUrl(params.path)
  try {
    await Taro.setClipboardData({ data: url })
    return { ok: true, via: 'clipboard', url }
  } catch {
    return { ok: false, reason: 'unsupported', message: '当前环境不支持分享，请手动复制链接' }
  }
}

function buildH5ShareUrl(path: string): string {
  if (typeof window === 'undefined') return path
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${window.location.origin}${normalized}`
}

/** 小程序页面 `onShareAppMessage` 直接返回这个对象即可。 */
export function buildShareConfig(params: ShareParams): {
  title: string
  path: string
  imageUrl?: string
} {
  return { title: params.title, path: params.path, imageUrl: params.imageUrl }
}
