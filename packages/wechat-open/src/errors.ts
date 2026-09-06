/**
 * 本包的错误类型与错误码。
 *
 * 错误码用蓝图 §4.9 的 7 位方案 `DD HHH NN`，域段固定 `17`（三方集成）。
 *
 * **真源在 `@taizan/contracts`**：17 域段的码全部登记在那边的 `ErrorCode` 内置表里，
 * 本文件的 {@link WechatOpenErrorCode} 只是那张表的**别名**（码值一字不差）。
 *
 * 这打破了本包「零依赖」的原则，是有意为之：`@taizan/contracts` 本身零运行时依赖、
 * 可在裸 node 环境跑单测，依赖它不会把框架拖进来；而错误码是四端契约面，
 * 同一个码在两个包里各写一遍，改一处就会漂——漂了不报错，
 * 只会让前端按一张过时的表做分流。两害相权，取「唯一真源」。
 */

import { ErrorCode } from '@taizan/contracts'

/** 三方集成域段。与 `@taizan/contracts` 的 `ERROR_DOMAIN.INTEGRATION` 保持一致 */
export const WECHAT_OPEN_ERROR_DOMAIN = 17

/**
 * 微信开放平台相关错误码（17 域段）—— `@taizan/contracts` 内置表的别名。
 *
 * 刻意分得细：这些错误的**处理人不同**。「ticket 还没收到」要平台去开放平台后台改回调 URL；
 * 「state 无效」是让用户重来一次；「redirect_uri 不安全」是我们自己的代码写错了，
 * 合成一个笼统的「微信调用失败」，三种情况都会跑来问客服。
 */
export const WechatOpenErrorCode = {
  /** 尚未收到微信推送的 component_verify_ticket */
  TICKET_MISSING: ErrorCode.WECHAT_TICKET_MISSING,
  /** 微信开放平台接口返回了 errcode */
  API_FAILED: ErrorCode.WECHAT_API_FAILED,
  /** access_token 失效（40001 / 42001），可自愈重试 */
  TOKEN_INVALID: ErrorCode.WECHAT_TOKEN_INVALID,
  /** 授权码校验失败 */
  AUTH_CODE_INVALID: ErrorCode.WECHAT_AUTH_CODE_INVALID,
  /** EncodingAESKey 配错 / 密文不合法 */
  MSG_DECRYPT_FAILED: ErrorCode.WECHAT_MSG_DECRYPT_FAILED,
  /** 密文里的 receiveId 与本平台不符 */
  RECEIVE_ID_MISMATCH: ErrorCode.WECHAT_RECEIVE_ID_MISMATCH,
  /** 消息签名校验不通过 */
  MSG_SIGNATURE_INVALID: ErrorCode.WECHAT_MSG_SIGNATURE_INVALID,
  /** 调用方给的回跳路径不安全（带 scheme / host / 协议相对） */
  UNSAFE_REDIRECT: ErrorCode.WECHAT_UNSAFE_REDIRECT,
  /** 当前请求的 Host 形状不合法，拒绝用它拼 redirect_uri */
  UNSAFE_HOST: ErrorCode.WECHAT_UNSAFE_HOST,
  /** state 不存在 / 已被用过 / 已过期 */
  STATE_INVALID: ErrorCode.WECHAT_STATE_INVALID,
  /** state 绑定的租户与当前租户不一致（拿 A 店的 state 去 B 店换登录） */
  STATE_TENANT_MISMATCH: ErrorCode.WECHAT_STATE_TENANT_MISMATCH,
  /** 中转站调用失败 */
  RELAY_FAILED: ErrorCode.WECHAT_RELAY_FAILED,
  /** 中转站会话不存在（sid 过期或已交付过 token） */
  RELAY_SESSION_GONE: ErrorCode.WECHAT_RELAY_SESSION_GONE,
  /** 一条公众号来源都不可用 */
  MP_SOURCE_UNAVAILABLE: ErrorCode.WECHAT_MP_SOURCE_UNAVAILABLE,
} as const

/** {@link WechatOpenErrorCode} 的键名 */
export type WechatOpenErrorName = keyof typeof WechatOpenErrorCode

/**
 * 本包抛出的唯一错误类型。
 *
 * 带上 `errcode`（微信原始错误码）与 `detail`：排查时最想知道的就是
 * 「微信到底回了什么」，而把它塞进 message 字符串里，上层想按码分流就只能做字符串匹配。
 */
export class WechatOpenError extends Error {
  readonly name = 'WechatOpenError'
  /** 7 位业务错误码（17 域段） */
  readonly code: number
  /** 微信 / 中转站返回的原始错误码，没有就是 null */
  readonly errcode: number | string | null
  /** 排查用的补充信息。**不要把密钥放进来** */
  readonly detail: string | null

  constructor(
    def: (typeof WechatOpenErrorCode)[WechatOpenErrorName],
    options: { detail?: string; errcode?: number | string | null; message?: string } = {},
  ) {
    super(options.message ?? def.message)
    this.code = def.code
    this.errcode = options.errcode ?? null
    this.detail = options.detail ?? null
  }
}

/** 造一个本包错误。写成函数只是为了调用处短一点 */
export function wechatOpenError(
  name: WechatOpenErrorName,
  options?: { detail?: string; errcode?: number | string | null; message?: string },
): WechatOpenError {
  return new WechatOpenError(WechatOpenErrorCode[name], options)
}
