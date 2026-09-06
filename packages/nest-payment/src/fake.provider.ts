/**
 * `FakeProvider` 的 Nest 装配 + e2e 用的 {@link FakePaymentTestKit}（蓝图 §4.12）。
 *
 * ## TestKit 为什么要真的发一次 HTTP
 *
 * e2e 里「下单 → 支付 → 发权益」中间那一步在真实环境是用户在微信里按了确认，测试跑不出来。
 * 常见的替代做法是**直接调领域处理器**——但那样跳过了验签、幂等、归一化、路由，
 * 恰恰跳过了最容易错的四段。
 *
 * 所以 `simulatePaid()` 的做法是：让 `FakeProvider` 生成一份**带真 HMAC 签名的**报文，
 * 然后 POST 到本 app 真实的 `/api/public/pay/:channel/notify` 路由上。链路一步不少。
 * 顺带的好处是「伪造签名必须被拒」这条断言在 e2e 里也成立（`opts.secret` 传个错的即可）。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import {
  FakeProvider,
  type FakeProviderOptions,
  type RawCallback,
  type SimulateCallbackOptions,
  type SimulateRefundCallbackOptions,
} from '@taizan/payment-core'
import type { Server } from 'node:http'

import { PAY_NOTIFY_ROUTE_PREFIX } from './payment.options'
import { FAKE_PAYMENT_PROVIDER } from './tokens'

/** 建一个供装配用的 `FakeProvider`。 */
export function createFakePaymentProvider(options: FakeProviderOptions = {}): FakeProvider {
  return new FakeProvider(options)
}

/** {@link FakePaymentTestKit} 打回来的应答。 */
export interface SimulatedCallbackResponse {
  status: number
  /** 原始应答文本（支付宝那种纯文本应答只有这个字段有意义）。 */
  text: string
  /** 能解成 JSON 就是对象，否则等于 `text`。 */
  body: unknown
}

/**
 * e2e 驱动器：把假回调 POST 进本 app 的回调路由。
 *
 * 只在 `PaymentModule.forRoot({ useFake: true })` 时注册。
 *
 * @example
 * ```ts
 * const kit = app.get(FakePaymentTestKit)
 * await payment.createOrder({ channel: 'WECHAT', outTradeNo, amountCents: 9900, ... })
 * const res = await kit.simulatePaid(outTradeNo)
 * expect(res.body).toEqual({ code: 'SUCCESS', message: '成功' })
 * ```
 */
@Injectable()
export class FakePaymentTestKit {
  constructor(
    @Inject(FAKE_PAYMENT_PROVIDER) readonly provider: FakeProvider,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  /** 只造报文不发送（想用 supertest 自己发时用它）。 */
  buildPaidCallback(outTradeNo: string, opts: SimulateCallbackOptions = {}): RawCallback {
    return this.provider.simulateCallback(outTradeNo, opts)
  }

  /** 只造退款报文不发送。 */
  buildRefundedCallback(
    outRefundNo: string,
    opts: SimulateRefundCallbackOptions = {},
  ): RawCallback {
    return this.provider.simulateRefundCallback(outRefundNo, opts)
  }

  /** 模拟「用户付款成功」：造报文 → POST 到本 app 的支付回调路由。 */
  async simulatePaid(
    outTradeNo: string,
    opts: SimulateCallbackOptions = {},
  ): Promise<SimulatedCallbackResponse> {
    const raw = this.provider.simulateCallback(outTradeNo, opts)
    return this.post(this.callbackPath(outTradeNo, 'notify'), raw)
  }

  /** 模拟「退款到账」：造报文 → POST 到本 app 的退款回调路由。 */
  async simulateRefunded(
    outRefundNo: string,
    opts: SimulateRefundCallbackOptions = {},
  ): Promise<SimulatedCallbackResponse> {
    const raw = this.provider.simulateRefundCallback(outRefundNo, opts)
    const refund = this.provider.getRefund(outRefundNo)
    return this.post(this.callbackPath(refund?.outTradeNo, 'refund-notify'), raw)
  }

  /**
   * 拼回调路径。
   *
   * 租户参数是从下单时记下的 `notifyUrl` 里原样抄回来的——真实渠道就是这么干的
   * （它把我们给的 notifyUrl 整个存下来再回调），自己另拼一份就可能和 `PaymentService`
   * 拼的那份不一致，而不一致的表现是「e2e 绿、线上租户配置取错」。
   */
  private callbackPath(outTradeNo: string | undefined, suffix: string): string {
    const base = `/${PAY_NOTIFY_ROUTE_PREFIX}/${this.provider.channel.toLowerCase()}/${suffix}`
    const notifyUrl = outTradeNo ? this.provider.getOrder(outTradeNo)?.notifyUrl : undefined
    if (!notifyUrl) return base
    const query = notifyUrl.includes('?') ? notifyUrl.slice(notifyUrl.indexOf('?')) : ''
    return `${base}${query}`
  }

  /**
   * 对本 app 发一次真实的 HTTP POST。
   *
   * 测试里的 app 通常只 `init()` 过、没 `listen()`，所以这里临时在 127.0.0.1 上
   * 挑个随机端口起来，发完再关掉；已经在监听的（真 e2e）就直接用。
   */
  private async post(path: string, raw: RawCallback): Promise<SimulatedCallbackResponse> {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined
    if (!server || typeof server.listen !== 'function') {
      throw new Error(
        '[@taizan/nest-payment] FakePaymentTestKit 需要一个 HTTP 应用；' +
          '请用 createNestApplication() 而不是 createApplicationContext()',
      )
    }

    const startedHere = !server.listening
    if (startedHere) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
    }
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('[@taizan/nest-payment] 拿不到测试服务器的端口')
      }
      const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: { ...raw.headers },
        body: raw.body,
      })
      const text = await res.text()
      return { status: res.status, text, body: parseMaybeJson(text) }
    } finally {
      if (startedHere) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
      }
    }
  }
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
