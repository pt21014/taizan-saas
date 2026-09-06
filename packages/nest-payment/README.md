# @taizan/nest-payment

支付的 **Nest 装配层**（蓝图 §4.12）。协议层在 [`@taizan/payment-core`](../payment-core)（`PaymentProvider` / `CallbackEvent` / `OutTradeNoRouter` / `FakeProvider`）与 [`@taizan/wechatpay`](../wechatpay)（微信 V3 实现）；本包只做三件事：

| 做什么 | 入口 |
| --- | --- |
| 按 `PayChannel` 装 Provider、按租户取商户密钥 | `ProviderRegistry` / `ProviderConfigResolver` |
| **唯一**的回调入口：验签 → 幂等 → 归一化 → 按前缀路由 | `PaymentNotifyController` |
| 下单 / 查单 / 退款的编排（拼 notifyUrl、退款前校验金额） | `PaymentService` |

```
POST /api/public/pay/:channel/notify          支付结果回调（幂等键 transactionId）
POST /api/public/pay/:channel/refund-notify   退款结果回调（幂等键 outRefundNo）
```

## 三条不可退让

1. **验签不过的回调一个字节都不落库**，也不进幂等表 —— 没验签之前，报文里的每个字段都是攻击者写的，包括 `transactionId`；先落库再验签等于让攻击者可以把真实回调的幂等键提前占掉。
2. **幂等键是 `transactionId`**（退款是 `outRefundNo`）。渠道必然重推（微信最多 15 次、跨度一整天），去重不该由每个领域各写一遍。
3. **本包不往上下文里注入租户**。回调没有 token，`tenantId` 由领域处理器按 `outTradeNo` 查自己的订单表后自行确定。框架替你猜租户，猜错时的表现是「A 店的钱发到了 B 店的账上」。

## 装配

```ts
// apps/api/src/bootstrap/main.ts —— 验签验的是原始字节，这行不能省
const app = await NestFactory.create(AppModule, { rawBody: true })

// apps/api/src/bootstrap/app.module.ts
PaymentModule.forRoot({
  providers: [new WechatPayProvider({ api: wechatPayApi })],
  vault: createVault({ keys: JSON.parse(env.CRYPTO_KEYS), currentKeyId: env.CRYPTO_KEY_CURRENT }),
  logger: appLogger,
  useFake: env.PAY_FAKE_ENABLED, // 生产必须 false，接进 assertNoDevCodeInProd 的开关清单
})
```

依赖：`InfraModule`（`IdempotencyService`，**必需**）、`PrismaModule`（只有默认的 `DbProviderConfigResolver` 要）、`AuditModule`（可选，没装就不记审计）、`CoreModule` 的 `ConfigService`（可选，用来读 `API_BASE_URL`；也可以直接传 `apiBaseUrl`）。

## 怎么注册一个领域处理器

三步。

**第一步：下单时用带前缀的商户单号。** 前缀就是领域标识，回调控制器只按它分发。

```ts
import { buildOutTradeNo } from '@taizan/payment-core'

const outTradeNo = buildOutTradeNo('SHOP') // 'SHOP-01JC0K3V7Q8ZP5R2M9YB4XN6TA'
```

> 前缀 1–6 位大写字母或数字；单号总长上限 32（微信的限制），ULID 占 26 位，**所以自动生成时前缀最多 5 位**。套餐订单用框架预置的 `PLAN_ORDER_PREFIX`。

**第二步：写处理器。** 加 `@PaymentHandler(prefix)`，它同时把 `prefix` 定义在原型上，实现类只需要 `declare` 一下让 TS 满意（`declare` 不产出代码，不会把原型上的值覆盖成 `undefined`）。

```ts
import { Injectable } from '@nestjs/common'
import { PaymentHandler, type PaymentEventHandler } from '@taizan/nest-payment'
import { runWithPatchedContext } from '@taizan/nest-core'
import type { CallbackEvent } from '@taizan/payment-core'

@Injectable()
@PaymentHandler('SHOP')
export class ShopOrderPaymentHandler implements PaymentEventHandler {
  declare readonly prefix: string

  async onPaid(event: CallbackEvent): Promise<void> {
    if (event.kind !== 'PAY_SUCCESS') return

    // raw-reason: 支付回调按参数定位租户（蓝图 §8 第 3 条）。
    // 回调进来时没有任何 token，先按全局唯一的 outTradeNo 找到订单，才知道是哪家店。
    const order = await this.prisma.raw.shopOrder.findUnique({
      where: { outTradeNo: event.outTradeNo },
      select: { id: true, tenantId: true, amountCents: true, status: true },
    })
    if (!order) throw new Error(`回调找不到订单 ${event.outTradeNo}`)
    // 金额必须比对：渠道回调里的钱才是真收到的钱。
    if (order.amountCents !== event.amountCents) throw new Error('回调金额与订单不符')

    // 拿到 tenantId 之后再切进租户上下文，后面就能用 prisma.tenant 了。
    await runWithPatchedContext({ tenantId: order.tenantId }, async () => {
      await this.fulfill(order.id, event)
    })
  }

  /** 不实现就是「这个领域不接退款回调」（控制器会打 error 并照常应答）。 */
  async onRefunded(event: RefundEvent): Promise<void> { /* ... */ }
}
```

**第三步：把它放进所在模块的 `providers`。** 剩下的交给 `DiscoveryService`，启动日志里会打出 `outTradeNo 前缀 [PLAN, SHOP]`。

几条约定：

- **`onPaid` 必须自己也是幂等的**。控制器那层挡的是「同一次回调被推了多次」；处理器还要挡「同一笔单被不同来源兑现两次」（回调 + 主动查单 + 后台手工核销），所以内部仍应基于订单状态判断。
- **抛错 = 请渠道重推**。控制器会回 500、释放幂等占位、记一条审计 FAIL。可以重试的错才抛；不可能重试好的错（金额对不上、订单不存在）应该记账后正常返回，否则渠道会敲你一整天。
- **两个类抢同一个前缀会在启动期直接抛**。覆盖的表现是「另一个领域的支付回调静默进了错误的处理器」——钱收了，货发错了。

## 商户密钥从哪来

`ProviderConfigResolver.resolve(channel, tenantId?)`：

- **不传 `tenantId` = 平台自身收款**（套餐订单走这条），读 `PlatformSetting`，`key` 前缀是 `pay.wechat.`；明文放 `value`，密钥放 `valueEnc` + `keyId`。
- **传了 `tenantId` = 商家自己的商户号**，读 `TenantCredential`（`provider = 'wechat-pay'`），全部用 vault 解密。

`credKey` / `PlatformSetting.key` 支持点分路径，`credentials.apiV3Key` 会拼成 `{ credentials: { apiV3Key } }` —— `@taizan/wechatpay` 的 `narrowWechatPayConfig` 要的就是这个嵌套形状。

商家自收款时，`PaymentService` 拼出来的 notifyUrl 会带上 `?tenant=<id>`：验签必须发生在解开报文**之前**，那一刻能定位租户的信息只有 URL。这正是蓝图 §8 第 3 条说的「支付回调按参数定位租户」那一处合法 raw 用途。

自己接管的话传 `configResolver` 即可；单渠道单商户可以直接用 `StaticProviderConfigResolver`。

## 怎么在 e2e 用 TestKit

`useFake: true` 时会装一个 `FakeProvider` 并暴露 `FakePaymentTestKit`。它的 `simulatePaid()` **真的发一次 HTTP** 打进本 app 的回调路由，验签、幂等、归一化、路由一段都不跳 —— 直接调处理器的测法恰恰跳过了最容易错的四段。

```ts
const kit = app.get(FakePaymentTestKit)
const payment = app.get(PaymentService)

const outTradeNo = buildOutTradeNo(PLAN_ORDER_PREFIX)
await payment.createOrder({
  channel: 'WECHAT',
  outTradeNo,
  amountCents: 9900,
  description: '专业版 1 年',
  payer: { kind: 'openid', value: 'o-fake-1' },
})

const res = await kit.simulatePaid(outTradeNo)
expect(res.status).toBe(200)
expect(res.body).toEqual({ code: 'SUCCESS', message: '成功' })

// 重推：处理器不该再被调一次
await kit.simulatePaid(outTradeNo)

// 伪造签名：400，且不留幂等占位
const forged = await kit.simulatePaid(outTradeNo, { secret: 'wrong' })
expect(forged.status).toBe(400)
```

签名是**真的**（HMAC-SHA256），所以「伪造回调必须被拒」这条断言在 e2e 里也成立。想自己用 supertest 发就用 `kit.buildPaidCallback(outTradeNo)` 拿报文。退款同理：`kit.simulateRefunded(outRefundNo)`。

测试里的 app 通常只 `init()` 过、没 `listen()`，TestKit 会临时在 `127.0.0.1` 上挑个随机端口起来，发完再关掉。

## 各渠道的应答报文

答错了的后果很一致：渠道认为你没收到，于是重推。

| 渠道 | 成功应答 |
| --- | --- |
| 微信 V3 | `200` + `{"code":"SUCCESS","message":"成功"}`（顶层 `code` 是**字符串**） |
| 支付宝 | `200` + 纯文本 `success` |
| 抖音 | `200` + `{"err_no":0,"err_tips":"success"}` |

所以这两条路由必须 `@RawResponse()`：套上 `{code:0,message:'ok',data:{...}}` 信封之后，微信读到顶层 `code` 是数字 `0`，判定失败并持续重投。要改用 `acks` 选项覆盖。

## 状态码怎么定的

| 情况 | 状态码 | 为什么 |
| --- | --- | --- |
| 验签失败 / 报文解不开 | **400** | 是调用方的错。回 5xx 会让渠道以为我们临时挂了，继续重推一个永远验不过的报文 |
| 渠道没装配 / 配置缺字段 | **500** | 是我们的错，配置修好之后这笔单能自愈 |
| 前缀没注册处理器 | **200 成功** | 部署问题，重推一天也不会自己好；打 error + 记审计 FAIL，钱的账留在审计里可以事后补兑现 |
| 处理器抛错 | **500** | 要的就是重推。幂等占位已被释放，下一次能重新进处理器 |

## 退款

```ts
await payment.refund({
  channel: 'WECHAT',
  outTradeNo,
  paidCents: 10000,      // 原单实付
  refundedCents: 3000,   // 此前已退累计，分次退款时必须传
  refundCents: 2000,
  outRefundNo,           // 先落库生成，重试必须复用同一个
})
```

金额校验发生在**调渠道之前**：渠道对超额退款回的是 `PARAM_ERROR`，看不出是金额关系不对；而分次退款各自都合法、加起来超了是最容易漏的那种。不传 `outRefundNo` 会自动生成 `RFD-<ULID>` —— 但同一笔退款重试换了单号就是发起第二笔退款，**会退两次钱**，所以正确用法永远是先落库再传进来。
