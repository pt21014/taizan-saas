/**
 * 跨端登录适配：小程序走 `Taro.login()`（拿 `code`，交给 `session.ts` 换 token）；
 * H5 没有等价的静默登录能力，`Taro.login()` 在 H5 环境下会直接 reject，
 * 这里统一收敛成一个「不支持」的结果，页面据此显示手机号登录表单而不是一键登录按钮。
 *
 * @packageDocumentation
 */

import Taro from '@tarojs/taro'

/** {@link loginWithPlatform} 的返回结果：拿到 code 或者说明当前端不支持。 */
export type PlatformLoginResult = { supported: true; code: string } | { supported: false }

/** 统一签名：不同端各自选分支，页面侧不需要关心 `process.env.TARO_ENV`。 */
export async function loginWithPlatform(): Promise<PlatformLoginResult> {
  if (process.env.TARO_ENV === 'weapp') {
    const { code } = await Taro.login()
    return code ? { supported: true, code } : { supported: false }
  }
  // H5：微信内 JSSDK 一键登录属于后端 OAuth 跳转流程（见 wechat-open 包），不在这里做；
  // 普通浏览器完全没有等价能力。两种情况都降级为「不支持」，由页面走短信/手机号登录。
  return { supported: false }
}
