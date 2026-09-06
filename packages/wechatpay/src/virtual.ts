/**
 * 小程序虚拟支付（`wx.requestVirtualPayment`，米大师）的参数组装与双 HMAC 签名。
 *
 * 纯函数，不碰数据库、不发请求。整体搬自 knowledge
 * `payment/virtual/virtual-pay.rules.ts`，去掉了「课程」这类业务字眼。
 *
 * ## 这是什么，为什么必须接
 *
 * 微信 2026-02-27 公告：**2026-04-01 起，小程序内涉及虚拟商品的支付必须接入
 * 「小程序虚拟支付」**，并明确禁止「引导用户至 APP / 公众号 / H5 / 外部网站完成支付」。
 * 录制课程、音视频内容、VIP 会员都算虚拟商品。在此之前 iOS 上「藏起购买入口 + 引导去浏览器」
 * 的做法，那句引导**本身现在就是违规项**。所以这条不是优化，是唯一合规的购买入口。
 *
 * ## 与普通微信支付 V3 的三个根本不同
 *
 * 1. **签名不是 RSA，是两把 HMAC-SHA256**。普通支付用商户私钥签、微信公钥验；
 *    这里是两个共享密钥各签一次：一把证明「这单是这个小程序开出来的」（appKey），
 *    一把证明「是这个用户本人在买」（session_key）。
 * 2. **钱不进商户号**，结算在微信侧，iOS 还要过 Apple 抽成。
 * 3. **没有分账接口**——不是没申请，是这条通道上不存在这个能力。
 */
import { createHmac } from 'node:crypto'

import { PAYMENT_ERROR, PaymentError } from '@taizan/payment-core'

/** 前端调起的签名 uri，微信规定就是接口名本身。 */
export const VIRTUAL_CLIENT_URI = 'requestVirtualPayment'

/** 道具直购模式：一个商品一个订单。另有代币模式 `short_series_coin`，本框架不用。 */
export const VIRTUAL_MODE_GOODS = 'short_series_goods'

/**
 * 环境。**0 = 正式，1 = 沙箱**。
 *
 * 这个字段最容易出事，因为**两种环境都「成功」**：沙箱下整条链路走得通、弹窗照常出现、
 * 回调照常来，只是**钱一分没动**。带着 `env: 1` 上线，表现是「订单都成了、货都发了、
 * 账上一分钱没有」，且没有任何一处会报错。所以 {@link resolveXpayEnv} **认不出一律当正式**：
 * 默认沙箱忘了配 = 白送货；默认正式忘了配 = 测试时真扣钱，那个第一次测试就会被发现。
 */
export type XpayEnv = 0 | 1

/** 组装 signData 的入参。 */
export interface BuildSignDataInput {
  /** 虚拟支付的应用 id，商家在小程序后台开通后拿到。 */
  offerId: string
  /** 我们的订单号，微信侧以它做幂等。 */
  outTradeNo: string
  /** 商品 id，微信只透传。 */
  productId: string
  /** 单价，单位**分**。必须由服务端从订单取，**绝不能收前端传来的值**。 */
  goodsPriceCents: number
  env: XpayEnv
  /** 透传给回调的自定义数据。 */
  attach?: string
  /** 购买数量，默认 1。 */
  buyQuantity?: number
}

/**
 * 组装 signData。**返回的是字符串，且必须原样用于签名与下发。**
 *
 * 这和支付回调「必须用原始报文字节验签」是同一个坑：把对象重新 `JSON.stringify` 一遍，
 * 键序或空白稍有不同，签出来的值就对不上，而微信只会回一句 `-15006 paySig 错误`。
 * 所以这里**一次性生成字符串**，上层拿到之后只准整体传递，不准解析回对象再序列化。
 */
export function buildSignData(input: BuildSignDataInput): string {
  const quantity = input.buyQuantity ?? 1
  const bad = (msg: string): never => {
    throw PaymentError.of(PAYMENT_ERROR.BAD_REQUEST, `[@taizan/wechatpay] ${msg}`)
  }
  if (!input.offerId) bad('缺少 offerId：商家还没开通虚拟支付')
  if (!input.outTradeNo) bad('缺少 outTradeNo')
  if (!Number.isInteger(input.goodsPriceCents) || input.goodsPriceCents <= 0) {
    // 0 元订单不该走到这里：免费领取根本不涉及支付，走这条等于凭空多一次失败
    bad('goodsPrice 必须是正整数（单位：分）')
  }
  if (!Number.isInteger(quantity) || quantity <= 0) bad('buyQuantity 必须是正整数')
  if (input.env !== 0 && input.env !== 1) bad('env 只能是 0（正式）或 1（沙箱）')

  // 字段顺序固定写死。**只放文档列出的字段，不自作主张多加**（比如 platform）：
  // signData 是原样参与签名的，多一个字段两边算出来的就是两个值，
  // 而微信只回一句「签名错误」，指不到是多了哪个字段。
  const payload: Record<string, unknown> = {
    offerId: input.offerId,
    buyQuantity: quantity,
    env: input.env,
    currencyType: 'CNY',
    productId: input.productId,
    goodsPrice: input.goodsPriceCents,
    outTradeNo: input.outTradeNo,
  }
  if (input.attach) payload['attach'] = input.attach
  return JSON.stringify(payload)
}

const hmacHex = (key: string, data: string): string =>
  createHmac('sha256', key).update(data, 'utf8').digest('hex')

/**
 * `paySig`：用**虚拟支付的 appKey** 对 `uri + '&' + signData` 签。
 *
 * 证明「这笔单确实由这个小程序的服务端开出」。**拼接的是 `uri` + `&` + `signData`，
 * 漏掉那个 `&` 是最容易犯的错**（表现同样是 -15006）。
 *
 * appKey 泄露 = 别人能替你开单，与推流 key、打款私钥同一档：加密落库，接口只回「配没配」。
 */
export function buildPaySig(appKey: string, signData: string, uri = VIRTUAL_CLIENT_URI): string {
  if (!appKey) {
    throw PaymentError.of(PAYMENT_ERROR.CONFIG_INVALID, '[@taizan/wechatpay] 缺少虚拟支付 appKey')
  }
  return hmacHex(appKey, `${uri}&${signData}`)
}

/**
 * `signature`：用**该用户本次登录的 session_key** 对 signData 本身签（不带 uri 前缀）。
 *
 * 证明「是这个用户本人在买」。它带来一个普通支付没有的约束：**必须把 session_key 存下来**
 * （加密），而它会随用户每次 `wx.login` 变化。用过期的 key 签出来的单会被微信拒，
 * 所以拒了要让前端重新登录再来一次——不给这条重试路径的话，
 * 表现是「换了台手机就再也买不了」。
 */
export function buildSignature(sessionKey: string, signData: string): string {
  if (!sessionKey) {
    throw PaymentError.of(
      PAYMENT_ERROR.BAD_REQUEST,
      '[@taizan/wechatpay] 缺少 session_key：请重新登录后再试',
    )
  }
  return hmacHex(sessionKey, signData)
}

/** 前端 `wx.requestVirtualPayment` 需要的全部参数。 */
export interface XpayParams {
  mode: typeof VIRTUAL_MODE_GOODS
  env: XpayEnv
  signData: string
  paySig: string
  signature: string
}

/**
 * 一次算出前端调起所需的全部参数。
 *
 * **收在一个函数里**是因为两个签名必须对**同一个 signData 字符串**做：
 * 分成两处各自组装的话，哪天有人改了其中一处的字段顺序，另一处签出来的值就对不上——
 * 而微信只会回一句签名错误，指不到是哪一处。
 */
export function buildXpayParams(
  input: BuildSignDataInput & { appKey: string; sessionKey: string },
): XpayParams {
  const signData = buildSignData(input)
  return {
    mode: VIRTUAL_MODE_GOODS,
    env: input.env,
    signData,
    paySig: buildPaySig(input.appKey, signData),
    signature: buildSignature(input.sessionKey, signData),
  }
}

/**
 * 服务端 `/xpay/*` 接口的签名。
 *
 * 与前端调起的区别只有 `uri`：这里是**接口路径本身**（如 `/xpay/query_order`），
 * **不带 `?` 及其后的 query**。`signData` 是 POST body 原文。
 * 结果放 query：`pay_sig=`；需要用户态的接口再加 `signature=`。
 */
export function signXpayServerRequest(input: {
  /** 接口路径，如 `/xpay/query_order`。 */
  uri: string
  /** POST body 原文。 */
  body: string
  appKey: string
  /** 需要用户态的接口才传。 */
  sessionKey?: string
}): { paySig: string; signature?: string } {
  const paySig = buildPaySig(input.appKey, input.body, input.uri)
  return input.sessionKey
    ? { paySig, signature: buildSignature(input.sessionKey, input.body) }
    : { paySig }
}

/**
 * 按 env 选 AppKey。
 *
 * 微信给每个小程序**两把** AppKey（MP「虚拟支付 → 基本配置」里分别叫现网与沙箱），
 * `env=0` 用前者、`env=1` 用后者——拿现网那把签沙箱单，微信只回 `-15006 paySig 错误`，
 * 指不到是密钥选错了环境。
 *
 * 沙箱缺 key 时**抛错而不是回落到现网那把**：回落签出来的单必然失败，
 * 而错误信息会把人引去查签名算法。
 */
export function pickXpayAppKey(input: {
  env: XpayEnv
  appKey: string | null | undefined
  sandboxAppKey: string | null | undefined
}): string {
  if (input.env === 1) {
    if (!input.sandboxAppKey) {
      throw PaymentError.of(
        PAYMENT_ERROR.CONFIG_INVALID,
        '[@taizan/wechatpay] 当前是沙箱环境（env=1），但未配置沙箱 AppKey',
      )
    }
    return input.sandboxAppKey
  }
  if (!input.appKey) {
    throw PaymentError.of(PAYMENT_ERROR.CONFIG_INVALID, '[@taizan/wechatpay] 缺少虚拟支付 appKey')
  }
  return input.appKey
}

/** 从环境变量取 env。**认不出一律当正式**，理由见 {@link XpayEnv}。 */
export function resolveXpayEnv(raw: string | undefined): XpayEnv {
  return String(raw).trim() === '1' ? 1 : 0
}

/**
 * 这家店此刻能不能走虚拟支付。
 *
 * 三个条件缺一不可，且**每一条缺失都要能说出是缺哪一条**：
 * 笼统回一句「暂不支持」的话，商家会在后台反复检查一个本来就对的配置。
 */
export function checkXpayReady(cfg: {
  offerId?: string | null
  appKey?: string | null
  enabled?: boolean | null
}): { ready: boolean; reason?: string } {
  if (!cfg.enabled) return { ready: false, reason: '本店尚未启用小程序虚拟支付' }
  if (!cfg.offerId) return { ready: false, reason: '未配置虚拟支付 offerId' }
  if (!cfg.appKey) return { ready: false, reason: '未配置虚拟支付 appKey' }
  return { ready: true }
}

/**
 * 这一单该不该走虚拟支付。
 *
 * **全终端，不分 iOS 与安卓。** 微信 2026-02-27 公告要求的就是全终端。
 * 这里一度做成「安卓由商家自己选」（安卓上普通微信支付仍然可用、费率低得多），
 * 那个判断是错的：**把它做成选项等于暗示「不开也行」**，而代价不是多付一截费率，
 * 是小程序被封。封号和省 5% 不在一个量级上，商家也没有判断这件事的信息。
 *
 * 真正的开关是这家店有没有开通并配好虚拟支付（`ready`）：没开通 → 走普通微信支付；
 * 开通了 → 小程序里一律走虚拟支付。拿 `ready` 当判据而不是「没配就报错」，
 * 是因为后者会在开关打开的那一刻让所有还没配好的店铺连安卓都买不了。
 */
export function shouldUseXpay(input: {
  /** 是不是在小程序里。H5 与公众号一律不走——虚拟支付只有小程序有。 */
  isMiniProgram: boolean
  /** 这家店开通并配好了虚拟支付。 */
  ready: boolean
  /** 0 元订单不走支付，自然也不走这条。 */
  amountCents: number
}): boolean {
  if (!input.isMiniProgram) return false
  if (!input.ready) return false
  return input.amountCents > 0
}
