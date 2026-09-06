/**
 * 跨端支付适配：小程序走 `Taro.requestPayment`（微信支付统一下单后的小程序调起参数）；
 * H5 分两种情况——微信内置浏览器可以用 `WeixinJSBridge` 调起 JSAPI 支付，普通浏览器
 * 没有等价能力，直接降级为提示文案，由页面引导「请在微信中打开」。
 *
 * 调起支付所需的参数（`timeStamp`/`nonceStr`/`package`/`signType`/`paySign`）由后端
 * `@taizan/nest-payment` 下单接口返回，这里只负责把同一份参数分发到正确的调起方式，
 * 不关心参数是怎么算出来的（那是 `@taizan/wechatpay` 的职责）。
 *
 * @packageDocumentation
 */

import Taro from '@tarojs/taro'

/** 微信支付调起参数（小程序 `Taro.requestPayment` 与 H5 JSAPI 共用同一形状）。 */
export interface WechatPayParams {
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'MD5' | 'HMAC-SHA256' | 'RSA'
  paySign: string
}

/** {@link pay} 的返回结果：`ok=false` 时 `reason` 说明是用户取消还是环境不支持。 */
export type PayResult =
  { ok: true } | { ok: false; reason: 'cancel' | 'unsupported'; message: string }

interface WeixinJSBridge {
  invoke(
    api: 'getBrandWCPayRequest',
    params: Record<string, string>,
    callback: (res: { err_msg: string }) => void,
  ): void
}

declare global {
  interface Window {
    WeixinJSBridge?: WeixinJSBridge
  }
}

/** 统一签名：调用方不需要关心 `process.env.TARO_ENV`。 */
export async function pay(params: WechatPayParams): Promise<PayResult> {
  if (process.env.TARO_ENV === 'weapp') {
    try {
      await Taro.requestPayment(params)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'cancel', message: errorMessage(error) }
    }
  }
  return payViaH5(params)
}

function payViaH5(params: WechatPayParams): Promise<PayResult> {
  if (typeof window === 'undefined' || !window.WeixinJSBridge) {
    return Promise.resolve({
      ok: false,
      reason: 'unsupported',
      message: '当前浏览器不支持微信支付，请在微信中打开本页面',
    })
  }
  const bridge = window.WeixinJSBridge
  return new Promise((resolve) => {
    bridge.invoke(
      'getBrandWCPayRequest',
      {
        timeStamp: params.timeStamp,
        nonceStr: params.nonceStr,
        package: params.package,
        signType: params.signType,
        paySign: params.paySign,
      },
      (res) => {
        resolve(
          res.err_msg === 'get_brand_wcpay_request:ok'
            ? { ok: true }
            : { ok: false, reason: 'cancel', message: res.err_msg },
        )
      },
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '支付已取消'
}
