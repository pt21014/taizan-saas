/**
 * 支付网关抽象（蓝图 §4.12）。
 *
 * 这一层的全部意义是：**领域代码永远不 import 任何一个渠道 SDK**。
 * 套餐订单只知道「下单 → 收到 CallbackEvent → 发权益」，
 * 至于钱是走微信 JSAPI 还是支付宝 Native，是 Provider 装配时决定的。
 */
import type {
  CallbackEvent,
  PayChannel,
  PayerRef,
  RefundEvent,
  RefundReq,
  RefundRes,
  TradeState,
} from './types'

/**
 * Provider 配置：**鸭子类型**。
 *
 * 框架不知道各渠道需要哪些字段（微信要 mchId/私钥/apiV3Key，支付宝要 appId/应用私钥），
 * 也不该知道——每加一个渠道就往一个大 union 里塞一个成员，等于每加一个渠道都改一次协议包。
 * 所以这里是 `Record<string, unknown>`，**由各 Provider 自己在入口处 narrow 并给出清楚的报错**
 * （见 `@taizan/wechatpay` 的 `narrowWechatPayConfig`）。
 *
 * 配置从哪来不归本包管：多租户下它由 `@taizan/crypto` 的 CredentialVault 解密后传入，
 * 所以 Provider 必须是**无状态**的——同一个 Provider 实例要能服务不同租户的不同配置。
 */
export type ProviderConfig = Record<string, unknown>

/** 统一下单请求（蓝图 §4.12）。 */
export interface CreateOrderReq {
  /** 商户订单号，用 `buildOutTradeNo()` 生成，前缀决定回调路由到哪个领域。 */
  outTradeNo: string
  /** 金额（分）。 */
  amountCents: number
  /** 商品描述（渠道会截断，各 Provider 自己按渠道上限截）。 */
  description: string
  /** 付款人。Native/H5 传 `{ kind: 'none' }`。 */
  payer: PayerRef
  /** 支付结果回调地址（https，且必须是公网可达的完整 URL）。 */
  notifyUrl: string
  /** 渠道特有参数（如微信的 `tradeType`、`payerClientIp`、`attach`、`profitSharing`）。 */
  extra?: Record<string, unknown>
}

/** 统一下单结果。 */
export interface CreateOrderRes {
  /**
   * 直接下发给前端的调起参数。
   *
   * 形状按渠道不同：微信 JSAPI 是二次签名后的 `{appId,timeStamp,nonceStr,package,signType,paySign}`，
   * Native 是 `{codeUrl}`，H5 是 `{h5Url}`。前端拿到什么用什么，**服务端不做二次加工**——
   * 加工过的签名参数一改就废。
   */
  payParams: Record<string, unknown>
  /** 渠道侧预支付标识（微信 prepay_id / 支付宝 tradeNo），便于排障对账。 */
  prepayRef?: string
}

/** 查单结果。 */
export interface QueryOrderRes {
  state: TradeState
  transactionId?: string
  amountCents?: number
  payer?: PayerRef
  raw?: unknown
}

/** 回调原始报文。**`body` 必须是未经任何解析的原始字符串**——验签验的就是这些字节。 */
export interface RawCallback {
  /**
   * 请求头。各渠道大小写不一（微信是 `Wechatpay-Signature`），
   * Provider 内部要按**大小写不敏感**取值，不能假设上层帮忙规范化过。
   */
  headers: Record<string, string>
  /**
   * 原始报文体。
   *
   * 上层控制器必须开 raw body（Nest 里是 `rawBody: true`），
   * 拿到 `body` 对象再 `JSON.stringify` 回来是**验签必挂**的经典错误：
   * 键序和空白和微信发过来的那串字节对不上。
   */
  body: string
}

/**
 * 支付渠道 Provider（蓝图 §4.12）。
 *
 * 实现约定：
 * - **无状态**：所有租户相关的东西都从 `cfg` 参数进来，不许在实例上缓存租户配置；
 * - **失败抛错**：验签失败抛 `SignatureError`，解析失败抛 `CallbackParseError`，
 *   其余抛 `PaymentError`。**不要返回 `null` 表示验签没过**——那太容易被上层顺手忽略；
 * - 金额一律「分」。
 */
export interface PaymentProvider {
  readonly channel: PayChannel

  createOrder(req: CreateOrderReq, cfg: ProviderConfig): Promise<CreateOrderRes>

  /** 验签 + 解密 + 归一化，任一步失败都抛。 */
  parseCallback(raw: RawCallback, cfg: ProviderConfig): Promise<CallbackEvent>

  queryOrder(outTradeNo: string, cfg: ProviderConfig): Promise<QueryOrderRes>

  refund(req: RefundReq, cfg: ProviderConfig): Promise<RefundRes>

  parseRefundCallback(raw: RawCallback, cfg: ProviderConfig): Promise<RefundEvent>
}
