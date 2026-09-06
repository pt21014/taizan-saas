/**
 * 支付域错误类型（蓝图 §4.9 的 7 位错误码，域段 16 = 支付）。
 *
 * ## 错误码的真源在 `@taizan/contracts`
 *
 * 16 域段的码全部登记在 `@taizan/contracts` 的 `ErrorCode` 内置表里，本文件的
 * {@link PAYMENT_ERROR} 只是那张表的**别名**（码值一字不差），存在的意义只是让包内
 * 与调用方继续写 `PAYMENT_ERROR.SIGNATURE_INVALID` 这种短名字。
 *
 * 为什么不用 `defineErrorCodes()` 在本包里注册：它只放行业务预留段 `20–89`，
 * 框架包要占 16 段就得写进内置表——而一旦两个地方都写一遍，改一处就会漂，
 * 漂了不报错，只会让前端按一张过时的表做分流。
 */
import { ErrorCode } from '@taizan/contracts'

/** 一条支付错误码定义：7 位码 + 默认中文提示。 */
export interface PaymentErrorDef {
  readonly code: number
  readonly message: string
}

/**
 * 支付域（16 段）错误码表 —— `@taizan/contracts` 内置表的别名。
 *
 * HTTP 语义段的选取原则：**「谁的错」决定语义**。伪造回调是调用方的错（400），
 * 上游微信/支付宝挂了是系统的错（500），订单查无此单是 404。
 */
export const PAYMENT_ERROR = {
  /** 通用支付参数错误（金额非法、outTradeNo 不合规等）。 */
  BAD_REQUEST: ErrorCode.PAYMENT_BAD_REQUEST,
  /** 回调验签失败（含序列号对不上、签名被伪造）。**绝不能落库**。 */
  SIGNATURE_INVALID: ErrorCode.PAYMENT_SIGNATURE_INVALID,
  /** 验签过了但报文解不开/字段缺失（解密失败、JSON 坏、algorithm 不支持）。 */
  CALLBACK_PARSE_FAILED: ErrorCode.PAYMENT_CALLBACK_PARSE_FAILED,
  /** outTradeNo 前缀没有注册领域处理器。 */
  ROUTE_NOT_FOUND: ErrorCode.PAYMENT_ROUTE_NOT_FOUND,
  /** 该渠道没有装配对应的 Provider。 */
  PROVIDER_NOT_FOUND: ErrorCode.PAYMENT_PROVIDER_NOT_FOUND,
  /** Provider 配置缺字段/形状不对（narrow 失败）。 */
  CONFIG_INVALID: ErrorCode.PAYMENT_CONFIG_INVALID,
  /** 查无此单。 */
  ORDER_NOT_FOUND: ErrorCode.PAYMENT_ORDER_NOT_FOUND,
  /** 上游支付网关报错/超时。 */
  UPSTREAM_ERROR: ErrorCode.PAYMENT_UPSTREAM_ERROR,
} as const satisfies Record<string, PaymentErrorDef>

/**
 * 支付域异常基类。
 *
 * 带着 7 位错误码抛，上层（`@taizan/nest-payment` 的异常过滤器）直接把 `code`
 * 放进统一响应包，不必再做一次「Error message 字符串 → 错误码」的猜测映射。
 */
export class PaymentError extends Error {
  /** 7 位错误码（域段固定 16）。 */
  readonly code: number
  /** 便于排障的附加上下文（不含密钥/私钥，日志可直接打）。 */
  readonly detail?: Record<string, unknown>

  constructor(code: number, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'PaymentError'
    this.code = code
    if (detail) this.detail = detail
  }

  /** 用 {@link PAYMENT_ERROR} 里的一条定义构造，可覆写提示文案。 */
  static of(
    def: PaymentErrorDef,
    message?: string,
    detail?: Record<string, unknown>,
  ): PaymentError {
    return new PaymentError(def.code, message ?? def.message, detail)
  }
}

/**
 * 验签失败。
 *
 * **单独一个类型**是因为它的处理方式和其它支付错误不同：验签失败的回调
 * 一个字节都不能落库、不能进幂等表、不能触发领域处理器，只能记一条安全日志并回 400。
 * 混在 `PaymentError` 里的话，上层很容易顺手把它当成「这次没成、下次重试」。
 */
export class SignatureError extends PaymentError {
  constructor(
    message: string = PAYMENT_ERROR.SIGNATURE_INVALID.message,
    detail?: Record<string, unknown>,
  ) {
    super(PAYMENT_ERROR.SIGNATURE_INVALID.code, message, detail)
    this.name = 'SignatureError'
  }
}

/**
 * 回调报文解析失败（验签**已经过了**，是解密或字段归一化这一步出的问题）。
 *
 * 与 {@link SignatureError} 分开，是因为两者的运维含义完全相反：
 * 验签失败大概率是攻击或配错了公钥，解析失败大概率是微信改了报文/我们的映射漏了字段——
 * 后者要报警给开发，前者要报警给安全。
 */
export class CallbackParseError extends PaymentError {
  constructor(
    message: string = PAYMENT_ERROR.CALLBACK_PARSE_FAILED.message,
    detail?: Record<string, unknown>,
  ) {
    super(PAYMENT_ERROR.CALLBACK_PARSE_FAILED.code, message, detail)
    this.name = 'CallbackParseError'
  }
}
