/**
 * `FakeProvider`：不联网的支付渠道实现，供 e2e 与本地开发使用（蓝图 §4.12 点名要的那个）。
 *
 * ## 它替代的是什么
 *
 * e2e 里「下单 → 支付 → 发权益」这条链路的中间那一步，在真实环境里是用户在微信里按了确认，
 * 测试跑不出来。常见的替代做法是**直接调领域处理器**，但那样跳过了验签、幂等、归一化，
 * 恰恰跳过了最容易错的三段。`FakeProvider` 的做法是：
 * {@link FakeProvider.simulateCallback} 生成一份**带真签名的**回调报文，
 * 测试把它 POST 到真实的回调控制器，链路一步不少地跑一遍。
 *
 * ## 签名是真的
 *
 * 用 HMAC-SHA256 而不是「跳过验签」，是为了让「伪造回调必须被拒」这条断言在 e2e 里也成立：
 * 改一个字节、或者用错 secret，`parseCallback` 就抛 {@link SignatureError}，
 * 与真实 Provider 的行为一致。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

import { ulid } from '@taizan/contracts'

import { CallbackParseError, PAYMENT_ERROR, PaymentError, SignatureError } from './errors'
import type {
  CreateOrderReq,
  CreateOrderRes,
  PaymentProvider,
  ProviderConfig,
  QueryOrderRes,
  RawCallback,
} from './provider'
import type {
  CallbackEvent,
  PayChannel,
  PayerRef,
  RefundEvent,
  RefundReq,
  RefundRes,
  TradeState,
} from './types'

/** 假回调的签名头名字（小写；取头时大小写不敏感）。 */
export const FAKE_SIGNATURE_HEADER = 'x-taizan-fake-signature'

/**
 * 没有在配置里给 secret 时用的默认值。
 * **只在测试环境用**——生产装配 FakeProvider 本身就是配置事故，不是这个常量的问题。
 */
export const FAKE_DEFAULT_SECRET = 'taizan-fake-provider-secret'

/** FakeProvider 内存里记下的一笔订单。 */
export interface FakeOrderRecord {
  outTradeNo: string
  amountCents: number
  description: string
  payer: PayerRef
  notifyUrl: string
  transactionId: string
  state: TradeState
  createdAt: Date
  paidAt: Date | null
  extra?: Record<string, unknown>
}

/** FakeProvider 内存里记下的一笔退款。 */
export interface FakeRefundRecord {
  outTradeNo: string
  outRefundNo: string
  refundId: string
  refundCents: number
  totalCents: number
  createdAt: Date
}

/** {@link FakeProvider} 构造参数。 */
export interface FakeProviderOptions {
  /** 冒充哪个渠道，默认 `'WECHAT'`（e2e 里通常就是拿它顶掉微信）。 */
  channel?: PayChannel
  /** 签名用的 secret，默认 {@link FAKE_DEFAULT_SECRET}；`cfg.fakeSecret` 优先级更高。 */
  secret?: string
}

/** {@link FakeProvider.simulateCallback} 的可选覆盖项。 */
export interface SimulateCallbackOptions {
  kind?: CallbackEvent['kind']
  /** 覆盖金额（分）。默认用下单时的金额；故意传错值可以测「金额不符」的防御分支。 */
  amountCents?: number
  paidAt?: Date
  transactionId?: string
  /** 用别的 secret 签，用来构造「伪造签名」的用例。 */
  secret?: string
}

/** {@link FakeProvider.simulateRefundCallback} 的可选覆盖项。 */
export interface SimulateRefundCallbackOptions {
  kind?: RefundEvent['kind']
  successAt?: Date
  secret?: string
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // 长度不同时 timingSafeEqual 会抛，先挡一下；长度本身不是秘密。
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** 大小写不敏感地取一个请求头。 */
function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v
  }
  return undefined
}

/**
 * 内存版支付 Provider。
 *
 * **有状态**（内存里记订单），这一点和真实 Provider 的「无状态」约定相反——
 * 因为它要模拟渠道那一侧的状态机。所以每个测试用例应该 `new` 一个新的，
 * 或者在 `beforeEach` 里调 {@link FakeProvider.reset}。
 */
export class FakeProvider implements PaymentProvider {
  readonly channel: PayChannel
  private readonly secret: string
  private readonly orders = new Map<string, FakeOrderRecord>()
  private readonly refunds = new Map<string, FakeRefundRecord>()

  constructor(opts: FakeProviderOptions = {}) {
    this.channel = opts.channel ?? 'WECHAT'
    this.secret = opts.secret ?? FAKE_DEFAULT_SECRET
  }

  /** 清空内存状态。 */
  reset(): void {
    this.orders.clear()
    this.refunds.clear()
  }

  /** 读一笔已下单的记录（断言下单参数用）。 */
  getOrder(outTradeNo: string): FakeOrderRecord | undefined {
    return this.orders.get(outTradeNo)
  }

  /** 全部订单（按下单顺序）。 */
  listOrders(): FakeOrderRecord[] {
    return [...this.orders.values()]
  }

  /** 读一笔退款记录。 */
  getRefund(outRefundNo: string): FakeRefundRecord | undefined {
    return this.refunds.get(outRefundNo)
  }

  private secretOf(cfg: ProviderConfig): string {
    const fromCfg = cfg['fakeSecret']
    return typeof fromCfg === 'string' && fromCfg.length > 0 ? fromCfg : this.secret
  }

  async createOrder(req: CreateOrderReq, _cfg: ProviderConfig): Promise<CreateOrderRes> {
    if (this.orders.has(req.outTradeNo)) {
      // 与真实渠道一致：同一个商户单号重复下单是错误，不是幂等成功。
      throw PaymentError.of(
        PAYMENT_ERROR.BAD_REQUEST,
        `FakeProvider: outTradeNo "${req.outTradeNo}" 已经下过单`,
        { outTradeNo: req.outTradeNo },
      )
    }
    const record: FakeOrderRecord = {
      outTradeNo: req.outTradeNo,
      amountCents: req.amountCents,
      description: req.description,
      payer: req.payer,
      notifyUrl: req.notifyUrl,
      transactionId: `FAKETXN${ulid()}`,
      state: 'NOTPAY',
      createdAt: new Date(),
      paidAt: null,
      ...(req.extra ? { extra: req.extra } : {}),
    }
    this.orders.set(req.outTradeNo, record)
    return {
      payParams: {
        provider: 'FAKE',
        channel: this.channel,
        outTradeNo: req.outTradeNo,
        amountCents: req.amountCents,
        prepayId: `FAKEPREPAY-${req.outTradeNo}`,
      },
      prepayRef: `FAKEPREPAY-${req.outTradeNo}`,
    }
  }

  /**
   * 生成一份能被 {@link FakeProvider.parseCallback} 接受的支付回调原始报文。
   *
   * 返回的就是 {@link RawCallback}：e2e 里把 `body` 原样 POST 到
   * `/api/public/pay/:channel/notify`，`headers` 原样带上即可。
   */
  simulateCallback(outTradeNo: string, opts: SimulateCallbackOptions = {}): RawCallback {
    const order = this.orders.get(outTradeNo)
    if (!order) {
      throw PaymentError.of(
        PAYMENT_ERROR.ORDER_NOT_FOUND,
        `FakeProvider: outTradeNo "${outTradeNo}" 还没下过单，无法模拟回调`,
        { outTradeNo },
      )
    }
    const kind = opts.kind ?? 'PAY_SUCCESS'
    const paidAt = opts.paidAt ?? new Date()
    const transactionId = opts.transactionId ?? order.transactionId
    const amountCents = opts.amountCents ?? order.amountCents

    if (kind === 'PAY_SUCCESS') {
      order.state = 'SUCCESS'
      order.paidAt = paidAt
      order.transactionId = transactionId
    } else {
      order.state = 'FAIL'
    }

    const body = JSON.stringify({
      eventType: kind === 'PAY_SUCCESS' ? 'TRANSACTION.SUCCESS' : 'TRANSACTION.FAIL',
      channel: this.channel,
      outTradeNo,
      transactionId,
      amountCents,
      paidAt: paidAt.toISOString(),
      payer: order.payer,
    })
    return {
      headers: {
        'content-type': 'application/json',
        [FAKE_SIGNATURE_HEADER]: hmac(opts.secret ?? this.secret, body),
      },
      body,
    }
  }

  /** 生成一份能被 {@link FakeProvider.parseRefundCallback} 接受的退款回调原始报文。 */
  simulateRefundCallback(
    outRefundNo: string,
    opts: SimulateRefundCallbackOptions = {},
  ): RawCallback {
    const refund = this.refunds.get(outRefundNo)
    if (!refund) {
      throw PaymentError.of(
        PAYMENT_ERROR.ORDER_NOT_FOUND,
        `FakeProvider: outRefundNo "${outRefundNo}" 还没申请过退款`,
        { outRefundNo },
      )
    }
    const kind = opts.kind ?? 'REFUND_SUCCESS'
    const successAt = kind === 'REFUND_SUCCESS' ? (opts.successAt ?? new Date()) : null
    const body = JSON.stringify({
      eventType: kind,
      channel: this.channel,
      outTradeNo: refund.outTradeNo,
      outRefundNo: refund.outRefundNo,
      refundId: refund.refundId,
      refundCents: refund.refundCents,
      totalCents: refund.totalCents,
      successAt: successAt?.toISOString() ?? null,
    })
    return {
      headers: {
        'content-type': 'application/json',
        [FAKE_SIGNATURE_HEADER]: hmac(opts.secret ?? this.secret, body),
      },
      body,
    }
  }

  private verify(raw: RawCallback, cfg: ProviderConfig): Record<string, unknown> {
    const sig = header(raw.headers, FAKE_SIGNATURE_HEADER)
    if (!sig) {
      throw new SignatureError(`FakeProvider: 回调缺少 ${FAKE_SIGNATURE_HEADER} 头`)
    }
    if (!safeEqual(sig, hmac(this.secretOf(cfg), raw.body))) {
      throw new SignatureError('FakeProvider: 回调签名不匹配（报文被改过，或 secret 配错了）')
    }
    let json: unknown
    try {
      json = JSON.parse(raw.body)
    } catch {
      throw new CallbackParseError('FakeProvider: 回调报文不是合法 JSON')
    }
    if (typeof json !== 'object' || json === null) {
      throw new CallbackParseError('FakeProvider: 回调报文不是对象')
    }
    return json as Record<string, unknown>
  }

  async parseCallback(raw: RawCallback, cfg: ProviderConfig): Promise<CallbackEvent> {
    const json = this.verify(raw, cfg)
    const outTradeNo = String(json['outTradeNo'] ?? '')
    if (!outTradeNo) throw new CallbackParseError('FakeProvider: 回调缺少 outTradeNo')
    const paidAtRaw = json['paidAt']
    return {
      kind: json['eventType'] === 'TRANSACTION.SUCCESS' ? 'PAY_SUCCESS' : 'PAY_FAIL',
      channel: this.channel,
      outTradeNo,
      transactionId: String(json['transactionId'] ?? ''),
      amountCents: Number(json['amountCents'] ?? 0),
      paidAt: typeof paidAtRaw === 'string' ? new Date(paidAtRaw) : new Date(),
      payer: (json['payer'] as PayerRef | undefined) ?? { kind: 'none' },
      raw: json,
    }
  }

  async queryOrder(outTradeNo: string, _cfg: ProviderConfig): Promise<QueryOrderRes> {
    const order = this.orders.get(outTradeNo)
    // 查无此单按「没付过」处理，与微信 4xx NOTFOUND 的语义一致。
    if (!order) return { state: 'NOTPAY' }
    return {
      state: order.state,
      transactionId: order.transactionId,
      amountCents: order.amountCents,
      payer: order.payer,
    }
  }

  async refund(req: RefundReq, _cfg: ProviderConfig): Promise<RefundRes> {
    const order = this.orders.get(req.outTradeNo)
    if (!order) {
      throw PaymentError.of(PAYMENT_ERROR.ORDER_NOT_FOUND, 'FakeProvider: 原支付单不存在', {
        outTradeNo: req.outTradeNo,
      })
    }
    const existing = this.refunds.get(req.outRefundNo)
    // 同一个退款单号重复申请必须幂等：真实渠道也是这么做的，
    // 否则「超时重试」会变成退两次钱。
    if (existing) {
      return { refundId: existing.refundId, status: 'SUCCESS', refundCents: existing.refundCents }
    }
    const record: FakeRefundRecord = {
      outTradeNo: req.outTradeNo,
      outRefundNo: req.outRefundNo,
      refundId: `FAKEREFUND${ulid()}`,
      refundCents: req.refundCents,
      totalCents: req.totalCents,
      createdAt: new Date(),
    }
    this.refunds.set(req.outRefundNo, record)
    order.state = 'REFUND'
    return { refundId: record.refundId, status: 'SUCCESS', refundCents: record.refundCents }
  }

  async parseRefundCallback(raw: RawCallback, cfg: ProviderConfig): Promise<RefundEvent> {
    const json = this.verify(raw, cfg)
    const successAtRaw = json['successAt']
    const kind = json['eventType']
    return {
      kind:
        kind === 'REFUND_SUCCESS' || kind === 'REFUND_FAIL' || kind === 'REFUND_CLOSED'
          ? kind
          : 'REFUND_FAIL',
      channel: this.channel,
      outTradeNo: String(json['outTradeNo'] ?? ''),
      outRefundNo: String(json['outRefundNo'] ?? ''),
      refundId: String(json['refundId'] ?? ''),
      refundCents: Number(json['refundCents'] ?? 0),
      totalCents: Number(json['totalCents'] ?? 0),
      successAt: typeof successAtRaw === 'string' ? new Date(successAtRaw) : null,
      raw: json,
    }
  }
}
