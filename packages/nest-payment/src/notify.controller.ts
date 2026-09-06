/**
 * 统一支付回调控制器（蓝图 §4.12）。
 *
 * ```
 * POST /api/public/pay/:channel/notify          验签 → 幂等(transactionId) → 归一化 → 按前缀路由
 * POST /api/public/pay/:channel/refund-notify   验签 → 幂等(outRefundNo)   → 归一化 → 按前缀路由
 * ```
 *
 * ## 四段顺序，一段都不能换
 *
 * | 段 | 失败时 | 为什么是这个位置 |
 * |---|---|---|
 * | 验签 | **400，一个字节都不落库** | 没验签之前报文里的每个字段都是攻击者写的，包括 `transactionId`。先落库再验签 = 攻击者可以往幂等表里塞任意键，把真实回调顶掉 |
 * | 幂等 | 第二次直接回成功 | 渠道必然重推（微信最多 15 次），处理器不可能每个都自己写一遍去重 |
 * | 归一化 | 400 | 领域处理器只认 `CallbackEvent`，不认 `sub_openid` / `trade_state` |
 * | 路由 | 打 error + **回成功** | 见下 |
 *
 * ## 未注册前缀为什么回成功
 *
 * 回失败会让渠道进入重推循环，而「前缀没注册」是**部署问题**（处理器所在模块没装上），
 * 重推一天也不会自己好。回成功 + 打 error + 记审计 FAIL：渠道安静下来，
 * 告警响起来，钱的账留在审计里可以事后补兑现。这是刻意在「自动重试」和
 * 「别把接口打死」之间选了后者。
 *
 * ## 租户
 *
 * 本控制器**不往上下文里注入租户**。回调没有 token，`tenantId` 由领域处理器
 * 按 `outTradeNo` 查自己的订单表后自行确定。控制器只用 `?tenant=` 查询参数来决定
 * 「用哪套商户密钥验签」——那是验签前就必须知道、且只能从 URL 拿的信息。
 *
 * @packageDocumentation
 */

import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common'
import { AuditService } from '@taizan/nest-audit'
import { Public, RateLimited } from '@taizan/nest-auth'
import { RawResponse } from '@taizan/nest-core'
import { IdempotencyService } from '@taizan/nest-infra'
import {
  CallbackParseError,
  isPayChannel,
  PaymentError,
  SignatureError,
  type CallbackEvent,
  type PayChannel,
  type RawCallback,
  type RefundEvent,
} from '@taizan/payment-core'
import type { Request, Response } from 'express'

import { ackSpecOf, type CallbackAck } from './callback-ack'
import { PaymentHandlerRegistry } from './handlers'
import type { PaymentLogger } from './logging'
import {
  PAY_CALLBACK_IDEMPOTENCY_SCOPE,
  PAY_NOTIFY_ROUTE_PREFIX,
  REFUND_CALLBACK_IDEMPOTENCY_SCOPE,
  type NormalizedPaymentOptions,
} from './payment.options'
import { ProviderRegistry, type ProviderConfigResolver } from './provider.registry'
import { PAYMENT_LOGGER, PAYMENT_OPTIONS, PROVIDER_CONFIG_RESOLVER } from './tokens'

const CONTEXT = 'PaymentNotifyController'

@Controller(PAY_NOTIFY_ROUTE_PREFIX)
export class PaymentNotifyController {
  constructor(
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(PROVIDER_CONFIG_RESOLVER) private readonly resolver: ProviderConfigResolver,
    @Inject(PaymentHandlerRegistry) private readonly handlers: PaymentHandlerRegistry,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PAYMENT_OPTIONS) private readonly options: NormalizedPaymentOptions,
    @Optional() @Inject(PAYMENT_LOGGER) private readonly logger?: PaymentLogger,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  /** 支付结果回调。 */
  @Post(':channel/notify')
  @Public()
  @RateLimited('public-default')
  @RawResponse()
  @HttpCode(200)
  async notify(
    @Param('channel') channelParam: string,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const channel = parseChannel(channelParam)
    const ack = ackSpecOf(channel, this.options.acks)

    let event: CallbackEvent
    try {
      event = await this.providers
        .get(channel)
        .parseCallback(readRawCallback(req), await this.resolveConfig(channel, req))
    } catch (err) {
      return this.rejectUnverified(res, ack.failure(reasonOf(err), statusOf(err)), channel, err)
    }

    const routed = this.handlers.tryRoute(event.outTradeNo)
    if (!routed) {
      this.logger?.error?.(
        `[@taizan/nest-payment] outTradeNo ${event.outTradeNo} 没有注册领域处理器` +
          `（已注册：${this.handlers.prefixes().join(', ') || '无'}），` +
          `这笔钱已到账但没有被兑现，请补兑现后再修装配`,
        undefined,
        CONTEXT,
      )
      await this.record(channel, event.outTradeNo, event.transactionId, 'FAIL', '未注册领域处理器')
      // 刻意回成功：重推一天也不会让「模块没装上」自己好，只会把接口打满。
      return this.send(res, ack.success)
    }

    // 幂等键取 transactionId（蓝图 §4.12）。渠道没给（PAY_FAIL 常见）时退回商户单号——
    // 空串当键会让所有失败回调共用一把锁，第一笔之后全部被当成重复。
    const key = event.transactionId || event.outTradeNo
    try {
      const outcome = await this.idempotency.run(
        PAY_CALLBACK_IDEMPOTENCY_SCOPE,
        key,
        async () => {
          await routed.handler.onPaid(event)
          return { handled: true }
        },
        this.options.idempotencyTtlSec,
      )
      if (!outcome.fresh) {
        this.logger?.debug?.(
          `[@taizan/nest-payment] ${channel} 回调 ${key} 是重复推送，已跳过处理器`,
          CONTEXT,
        )
        return this.send(res, ack.success)
      }
    } catch (err) {
      this.logger?.error?.(
        `[@taizan/nest-payment] 领域处理器 ${routed.prefix} 处理 ${event.outTradeNo} 失败：${reasonOf(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
      await this.record(channel, event.outTradeNo, key, 'FAIL', reasonOf(err))
      // 500 让渠道重推。幂等占位已经被 IdempotencyService 在 catch 里释放掉了，
      // 下一次重推能重新进到处理器——否则这笔单会被锁死一整个 TTL。
      return this.send(res, ack.failure(reasonOf(err), 500))
    }

    await this.record(channel, event.outTradeNo, key, 'SUCCESS')
    return this.send(res, ack.success)
  }

  /** 退款结果回调。 */
  @Post(':channel/refund-notify')
  @Public()
  @RateLimited('public-default')
  @RawResponse()
  @HttpCode(200)
  async refundNotify(
    @Param('channel') channelParam: string,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const channel = parseChannel(channelParam)
    const ack = ackSpecOf(channel, this.options.acks)

    let event: RefundEvent
    try {
      event = await this.providers
        .get(channel)
        .parseRefundCallback(readRawCallback(req), await this.resolveConfig(channel, req))
    } catch (err) {
      return this.rejectUnverified(res, ack.failure(reasonOf(err), statusOf(err)), channel, err)
    }

    const routed = this.handlers.tryRoute(event.outTradeNo)
    if (!routed || !routed.handler.onRefunded) {
      this.logger?.error?.(
        `[@taizan/nest-payment] 退款回调 ${event.outRefundNo}（原单 ${event.outTradeNo}）` +
          `${routed ? `的处理器 ${routed.prefix} 没有实现 onRefunded` : '没有注册领域处理器'}`,
        undefined,
        CONTEXT,
      )
      await this.record(channel, event.outRefundNo, event.refundId, 'FAIL', '退款回调无人处理')
      return this.send(res, ack.success)
    }

    const onRefunded = routed.handler.onRefunded.bind(routed.handler)
    try {
      // 幂等键是 outRefundNo：一笔支付可以退多次，用 transactionId 会把第二次退款吞掉。
      const outcome = await this.idempotency.run(
        REFUND_CALLBACK_IDEMPOTENCY_SCOPE,
        event.outRefundNo,
        async () => {
          await onRefunded(event)
          return { handled: true }
        },
        this.options.idempotencyTtlSec,
      )
      if (!outcome.fresh) return this.send(res, ack.success)
    } catch (err) {
      this.logger?.error?.(
        `[@taizan/nest-payment] 退款处理器 ${routed.prefix} 处理 ${event.outRefundNo} 失败：${reasonOf(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
      await this.record(channel, event.outRefundNo, event.outRefundNo, 'FAIL', reasonOf(err))
      return this.send(res, ack.failure(reasonOf(err), 500))
    }

    await this.record(channel, event.outRefundNo, event.outRefundNo, 'SUCCESS')
    return this.send(res, ack.success)
  }

  /** 验签/解析没过：**不落库、不进幂等**，只打日志并按渠道格式回失败。 */
  private rejectUnverified(
    res: Response,
    ack: CallbackAck,
    channel: PayChannel,
    err: unknown,
  ): unknown {
    this.logger?.error?.(
      `[@taizan/nest-payment] ${channel} 回调未通过验签/解析（${ack.status}）：${reasonOf(err)}`,
      err instanceof Error ? err.stack : undefined,
      CONTEXT,
    )
    return this.send(res, ack)
  }

  /** 取本次回调该用哪套商户配置。查询参数带了租户就用租户的，没带就是平台自身收款。 */
  private async resolveConfig(
    channel: PayChannel,
    req: Request,
  ): Promise<Awaited<ReturnType<ProviderConfigResolver['resolve']>>> {
    const raw: unknown = req.query?.[this.options.tenantQueryParam]
    const tenantId = typeof raw === 'string' && raw.length > 0 ? raw : undefined
    return this.resolver.resolve(channel, tenantId)
  }

  private send(res: Response, ack: CallbackAck): unknown {
    res.status(ack.status)
    return ack.body
  }

  /**
   * 记一条平台域审计。
   *
   * 走 `recordPlatform` 而不是 `record`：回调没有租户上下文，`AuditLog` 是租户域表，
   * 写它会被隔离扩展当场拦下。审计写失败**不影响应答**——渠道要的是「你收到了没」，
   * 让它因为我们记不上日志而重推一整天是本末倒置；打 error 让监控看得到就够了。
   */
  private async record(
    channel: PayChannel,
    targetId: string,
    key: string,
    result: 'SUCCESS' | 'FAIL',
    reason?: string,
  ): Promise<void> {
    if (!this.audit) return
    try {
      await this.audit.recordPlatform({
        action: 'payment.callback',
        actorType: 'SYSTEM',
        actorId: 'pay-notify',
        actorName: `支付回调(${channel})`,
        targetType: 'PaymentCallback',
        targetId,
        after: { channel, key, result, ...(reason ? { reason } : {}) },
        result,
      })
    } catch (err) {
      this.logger?.error?.(
        `[@taizan/nest-payment] 写支付回调审计失败：${reasonOf(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
    }
  }
}

/** 路由参数 → `PayChannel`。大小写不敏感（notifyUrl 里我们写小写，微信原样回传）。 */
export function parseChannel(value: string): PayChannel {
  const upper = String(value ?? '').toUpperCase()
  if (!isPayChannel(upper)) {
    throw new BadRequestException(`未知支付渠道：${String(value)}`)
  }
  return upper
}

/**
 * 取**原始字节**的报文体。
 *
 * 验签验的就是这些字节：拿解析过的对象再 `JSON.stringify` 回来，键序和空白都对不上
 * 微信发过来的那串，签名必挂。所以 `apps/api` 的 `NestFactory.create` 必须开
 * `{ rawBody: true }`——这里在拿不到时抛一句能直接照做的错，而不是让它表现成
 * 「所有回调都验签失败」。
 */
export function readRawCallback(req: RawBodyRequest<Request>): RawCallback {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (typeof v === 'string') headers[k] = v
    else if (Array.isArray(v)) headers[k] = v.join(',')
  }

  const rawBody: unknown = req.rawBody
  if (Buffer.isBuffer(rawBody)) return { headers, body: rawBody.toString('utf8') }

  const body: unknown = req.body
  if (typeof body === 'string') return { headers, body }
  if (Buffer.isBuffer(body)) return { headers, body: body.toString('utf8') }

  throw new CallbackParseError(
    '[@taizan/nest-payment] 拿不到原始报文体：请用 NestFactory.create(AppModule, { rawBody: true }) 启动，' +
      '验签验的是原始字节，把解析后的对象再 stringify 回来一定验不过',
  )
}

/** 验签/解析类错误一律 400（别回 5xx，渠道会以为我们临时挂了而重推一个永远验不过的报文）。 */
function statusOf(err: unknown): number {
  if (err instanceof SignatureError || err instanceof CallbackParseError) return 400
  // 渠道没装配、配置缺字段是**我们**的问题，回 5xx 让渠道重推：配置修好之后这笔单能自愈。
  if (err instanceof PaymentError) return 500
  return 500
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
