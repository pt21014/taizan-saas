/**
 * `PaymentService`：下单 / 查单 / 退款的编排层。
 *
 * 它做的三件事，每一件单独看都很小，但都是「每个调用点自己写一遍就一定有人写错」的那种：
 *
 * 1. **拼 notifyUrl**。回调地址必须与统一回调控制器的路由严格一致，且商家自收款时
 *    要带上租户参数（否则回调进来验签阶段不知道该用谁的密钥）。写错的表现是
 *    「钱收到了，回调 404，订单永远 PENDING」；
 * 2. **取配置**。租户级密钥要解密，平台级要从 `PlatformSetting` 读，两条路都不该
 *    出现在业务代码里；
 * 3. **退款前校验金额**。退多于已付是**不可逆**的资损，必须在调渠道之前挡住。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, Optional } from '@nestjs/common'
import { AuditService } from '@taizan/nest-audit'
import { BizException } from '@taizan/nest-core'
import {
  buildOutTradeNo,
  PAYMENT_ERROR,
  type CreateOrderRes,
  type PayChannel,
  type PayerRef,
  type QueryOrderRes,
  type RefundRes,
} from '@taizan/payment-core'

import type { PaymentLogger } from './logging'
import {
  PAY_NOTIFY_ROUTE_PREFIX,
  REFUND_NO_PREFIX,
  type NormalizedPaymentOptions,
} from './payment.options'
import { ProviderRegistry, type ProviderConfigResolver } from './provider.registry'
import {
  PAYMENT_API_BASE_URL,
  PAYMENT_LOGGER,
  PAYMENT_OPTIONS,
  PROVIDER_CONFIG_RESOLVER,
} from './tokens'

const CONTEXT = 'PaymentService'

/** 下单参数。 */
export interface CreateOrderParams {
  channel: PayChannel
  /** 商户订单号，用 `buildOutTradeNo(prefix)` 生成——前缀决定回调路由到哪个领域。 */
  outTradeNo: string
  /** 金额（分）。 */
  amountCents: number
  description: string
  payer: PayerRef
  /**
   * 用哪家店的商户号收款。
   *
   * 不传 = **平台自身收款**（套餐订单走这条，钱进平台的账）。
   * 传了 = 商家自己的商户号，回调地址会带上 `?tenant=`，回调时按它取密钥验签。
   */
  tenantId?: string
  /** 渠道特有参数（微信的 `tradeType` / `payerClientIp` / `attach` 等）。 */
  extra?: Record<string, unknown>
  /** 覆盖回调地址。**除非你知道自己在干什么**，否则别传。 */
  notifyUrl?: string
}

/** 查单参数。 */
export interface QueryOrderParams {
  channel: PayChannel
  outTradeNo: string
  tenantId?: string
}

/** 退款参数。 */
export interface RefundParams {
  channel: PayChannel
  /** 原支付的商户订单号。 */
  outTradeNo: string
  /** 原单**实付**金额（分）。退款总额不得超过它。 */
  paidCents: number
  /** 本次退款金额（分）。 */
  refundCents: number
  /** 这笔单**此前已退**的累计金额（分），默认 0。分次退款时必须传，否则能退超。 */
  refundedCents?: number
  /**
   * 商户退款单号。不传自动生成 `RFD-<ULID>`。
   *
   * **同一笔退款重试必须复用同一个单号**——换一个就是发起了第二笔退款，会退两次钱。
   * 所以正确用法是：先落库生成单号，再调本方法并把单号传进来。
   */
  outRefundNo?: string
  reason?: string
  tenantId?: string
  /** 退款结果回调地址。不传时自动拼 `/refund-notify`。 */
  notifyUrl?: string
  extra?: Record<string, unknown>
}

/** 退款结果，比 `RefundRes` 多回一个本次实际用的退款单号。 */
export interface RefundOutcome extends RefundRes {
  outRefundNo: string
}

@Injectable()
export class PaymentService {
  constructor(
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(PROVIDER_CONFIG_RESOLVER) private readonly resolver: ProviderConfigResolver,
    @Inject(PAYMENT_OPTIONS) private readonly options: NormalizedPaymentOptions,
    @Inject(PAYMENT_API_BASE_URL) private readonly apiBaseUrl: string,
    @Optional() @Inject(PAYMENT_LOGGER) private readonly logger?: PaymentLogger,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  /** 支付结果回调地址。 */
  notifyUrlFor(channel: PayChannel, tenantId?: string): string {
    return this.callbackUrl(channel, 'notify', tenantId)
  }

  /** 退款结果回调地址。 */
  refundNotifyUrlFor(channel: PayChannel, tenantId?: string): string {
    return this.callbackUrl(channel, 'refund-notify', tenantId)
  }

  /** 统一下单。返回的 `payParams` **原样下发给前端，不许改任何一个字段**（改了签名就废）。 */
  async createOrder(params: CreateOrderParams): Promise<CreateOrderRes> {
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw new BizException(
        PAYMENT_ERROR.BAD_REQUEST.code,
        `下单金额必须是正整数分，收到 ${String(params.amountCents)}`,
      )
    }
    const provider = this.providers.get(params.channel)
    const cfg = await this.resolver.resolve(params.channel, params.tenantId)
    const res = await provider.createOrder(
      {
        outTradeNo: params.outTradeNo,
        amountCents: params.amountCents,
        description: params.description,
        payer: params.payer,
        notifyUrl: params.notifyUrl ?? this.notifyUrlFor(params.channel, params.tenantId),
        ...(params.extra ? { extra: params.extra } : {}),
      },
      cfg,
    )
    this.logger?.log?.(
      `[@taizan/nest-payment] ${params.channel} 下单 ${params.outTradeNo}（${params.amountCents} 分）`,
      CONTEXT,
    )
    return res
  }

  /** 主动查单。回调丢了、或用户回到页面时对账用。 */
  async queryOrder(params: QueryOrderParams): Promise<QueryOrderRes> {
    const cfg = await this.resolver.resolve(params.channel, params.tenantId)
    return this.providers.get(params.channel).queryOrder(params.outTradeNo, cfg)
  }

  /**
   * 退款。
   *
   * 校验顺序刻意是「先算钱再调渠道」：渠道对超额退款回的是 `PARAM_ERROR`，
   * 看不出是金额关系不对；而更糟的情况是分次退款各自都合法、加起来超了，
   * 渠道那边按累计额挡，报错更含糊。
   */
  async refund(params: RefundParams): Promise<RefundOutcome> {
    const refunded = params.refundedCents ?? 0
    if (!Number.isInteger(params.refundCents) || params.refundCents <= 0) {
      throw new BizException(
        PAYMENT_ERROR.BAD_REQUEST.code,
        `退款金额必须是正整数分，收到 ${String(params.refundCents)}`,
      )
    }
    if (refunded + params.refundCents > params.paidCents) {
      throw new BizException(
        PAYMENT_ERROR.BAD_REQUEST.code,
        `退款金额超过已付：本次 ${params.refundCents} 分 + 已退 ${refunded} 分 > 实付 ${params.paidCents} 分`,
        { paidCents: params.paidCents, refundedCents: refunded, refundCents: params.refundCents },
      )
    }

    const outRefundNo = params.outRefundNo ?? buildOutTradeNo(REFUND_NO_PREFIX)
    const cfg = await this.resolver.resolve(params.channel, params.tenantId)
    const res = await this.providers.get(params.channel).refund(
      {
        outTradeNo: params.outTradeNo,
        outRefundNo,
        totalCents: params.paidCents,
        refundCents: params.refundCents,
        notifyUrl: params.notifyUrl ?? this.refundNotifyUrlFor(params.channel, params.tenantId),
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.extra ? { extra: params.extra } : {}),
      },
      cfg,
    )

    this.logger?.log?.(
      `[@taizan/nest-payment] ${params.channel} 退款 ${outRefundNo}（原单 ${params.outTradeNo}，` +
        `${params.refundCents} 分，渠道状态 ${res.status}）`,
      CONTEXT,
    )
    await this.recordRefund(params, outRefundNo, res)
    return { ...res, outRefundNo }
  }

  private callbackUrl(channel: PayChannel, suffix: string, tenantId?: string): string {
    const base = this.apiBaseUrl.replace(/\/+$/, '')
    const url = `${base}/${PAY_NOTIFY_ROUTE_PREFIX}/${channel.toLowerCase()}/${suffix}`
    if (tenantId === undefined) return url
    // 商家自收款：回调进来时还没解开报文就要选对密钥，租户只能从 URL 拿。
    return `${url}?${this.options.tenantQueryParam}=${encodeURIComponent(tenantId)}`
  }

  /** 退款留痕。写失败不影响退款结果（钱已经退出去了，这时候抛异常只会误导调用方重试）。 */
  private async recordRefund(
    params: RefundParams,
    outRefundNo: string,
    res: RefundRes,
  ): Promise<void> {
    if (!this.audit) return
    try {
      await this.audit.recordPlatform({
        action: 'payment.refund',
        actorType: 'SYSTEM',
        actorId: 'payment-service',
        actorName: `支付退款(${params.channel})`,
        targetType: 'PaymentRefund',
        targetId: outRefundNo,
        ...(params.tenantId ? { targetTenantId: params.tenantId } : {}),
        after: {
          channel: params.channel,
          outTradeNo: params.outTradeNo,
          outRefundNo,
          refundCents: params.refundCents,
          paidCents: params.paidCents,
          refundId: res.refundId,
          status: res.status,
        },
        result: 'SUCCESS',
      })
    } catch (err) {
      this.logger?.error?.(
        `[@taizan/nest-payment] 写退款审计失败：${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
    }
  }
}
