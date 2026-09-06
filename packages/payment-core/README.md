# @taizan/payment-core

支付网关抽象（蓝图 §4.12）。**零框架依赖**，只依赖 `@taizan/contracts`，可以在裸 node 环境跑单测。

这一层的全部意义是：**领域代码永远不 import 任何一个渠道 SDK**。套餐订单只知道「下单 → 收到 `CallbackEvent` → 发权益」，钱是走微信 JSAPI 还是支付宝 Native，是 Provider 装配时决定的。

## 导出了什么

| 模块 | 内容 |
|---|---|
| `provider.ts` | `PaymentProvider` 接口、`ProviderConfig`（鸭子类型）、`CreateOrderReq/Res`、`QueryOrderRes`、`RawCallback` |
| `types.ts` | `PayChannel`（与 Prisma enum 同值）、`TradeState`、`CallbackEvent`、`RefundEvent`、`RefundReq/Res`、`PayerRef` |
| `out-trade-no.ts` | `buildOutTradeNo` / `parseOutTradeNo` / `OutTradeNoRouter` / `PLAN_ORDER_PREFIX` |
| `money.ts` | 复用 contracts 的 `assertCents`，加 `splitAmount`（分账拆分，总和不变）与 `calcCommissionCents` |
| `errors.ts` | `PAYMENT_ERROR` 码表（16 域段）、`PaymentError` / `SignatureError` / `CallbackParseError` |
| `fake-provider.ts` | `FakeProvider`：内存实现 + `simulateCallback`，供 e2e |

金额一律用「分」表示的整数，字段名以 `Cents` 结尾（蓝图 §3.1）。

## 商户订单号：`PREFIX-ULID`

统一回调控制器 `POST /api/public/pay/:channel/notify` 收到回调后，唯一能用来判断「这笔钱是买什么的」、且由我们自己控制的信息就是 `outTradeNo`。所以单号写成 `PREFIX-ULID`，前缀是领域标识：

```ts
import { PLAN_ORDER_PREFIX, buildOutTradeNo, parseOutTradeNo } from '@taizan/payment-core'

buildOutTradeNo(PLAN_ORDER_PREFIX)  // 'PLAN-01JC0K3V7Q8ZP5R2M9YB4XN6TA'（31 位）
parseOutTradeNo('PLAN-01JC0K…')     // { prefix: 'PLAN', id: '01JC0K…' }
```

- 总长上限 32（微信 V3 的 `out_trade_no` 是 6–32 位）；
- 前缀 1–6 位大写字母/数字，但 **ULID 占 26 位，所以自动生成时前缀最多 5 位**，超了会在下单前抛错而不是让微信回一句 `PARAM_ERROR`；
- 前缀重复注册直接抛错，不是后者覆盖前者——覆盖的表现是「钱收了、货发错了」。

## 怎么加一个新支付渠道

以「加支付宝」为例，四步，**一步都不用改本包**：

1. **新建包** `packages/alipay`，依赖 `@taizan/payment-core`，照抄 `packages/wechatpay` 的目录形状（零框架依赖，HTTP 走注入的 client）。

2. **narrow 配置**。`ProviderConfig` 是 `Record<string, unknown>`，各 Provider 自己收窄并给出**指到具体字段**的报错：

   ```ts
   export function narrowAlipayConfig(cfg: ProviderConfig): AlipayConfig {
     // 缺字段就抛 PAYMENT_ERROR.CONFIG_INVALID，message 写清缺的是哪一项
   }
   ```

   做成鸭子类型而不是一个大 union，是为了「每加一个渠道」不必「改一次协议包」。

3. **实现 `PaymentProvider`** 六个方法。三条硬约定：

   - **无状态**：租户相关的一切从 `cfg` 参数进来，不许在实例上缓存租户配置（同一个实例要服务不同租户）；
   - **失败抛错**：验签失败抛 `SignatureError`，解析失败抛 `CallbackParseError`，其余抛 `PaymentError`。**不要返回 `null` 表示验签没过**；
   - **`parseCallback` 只吃原始字节**：`RawCallback.body` 必须是未经解析的原始字符串，headers 要大小写不敏感地取。

4. **在 `PayChannel` 上加一个值**——`packages/payment-core/src/types.ts` 的联合与 Prisma schema 的 enum **两处都要改**，少改一处的表现是「数据库存得进去、代码里 narrow 不到」。然后在 `@taizan/nest-payment` 的 registry 里注册。

新渠道自带的 spec 至少要覆盖：签名的官方样例逐字节比对、回调往返、**伪造签名被拒**。

## 怎么在 e2e 用 FakeProvider

e2e 里「下单 → 支付 → 发权益」的中间那一步在真实环境是用户在微信里按了确认，测试跑不出来。常见的替代做法是直接调领域处理器，但那样跳过了验签、幂等、归一化——恰恰是最容易错的三段。

`FakeProvider` 的做法是生成一份**带真签名的**回调报文，让测试把它 POST 到真实的回调控制器：

```ts
import { FakeProvider, PLAN_ORDER_PREFIX, buildOutTradeNo } from '@taizan/payment-core'

const provider = new FakeProvider()          // 默认 channel 'WECHAT'，顶掉真微信
const outTradeNo = buildOutTradeNo(PLAN_ORDER_PREFIX)

// 1) 下单（业务接口内部会调到它）
await provider.createOrder(
  { outTradeNo, amountCents: 9900, description: '专业版 1 年',
    payer: { kind: 'openid', value: 'o_test' },
    notifyUrl: 'https://example.com/api/public/pay/WECHAT/notify' },
  cfg,
)

// 2) 造一份回调，POST 到真实控制器
const raw = provider.simulateCallback(outTradeNo)
await request(app.getHttpServer())
  .post('/api/public/pay/WECHAT/notify')
  .set(raw.headers)
  .send(raw.body)

// 3) 断言权益已发；再发一次同样的回调，断言只处理了一次（幂等）
```

要点：

- **签名是真的**（HMAC-SHA256）。改一个字节、或用 `simulateCallback(no, { secret: 'attacker' })` 换个密钥，`parseCallback` 就抛 `SignatureError`——「伪造回调必须被拒」这条断言在 e2e 里同样成立；
- 多租户下 secret 可以由配置给：`cfg.fakeSecret` 优先于构造参数；
- `FakeProvider` **有状态**（内存里记订单），与真实 Provider 的无状态约定相反，因为它要模拟渠道那一侧的状态机。每个用例 `new` 一个新的，或在 `beforeEach` 里 `reset()`；
- 退款同理：`refund()` → `simulateRefundCallback(outRefundNo)` → `parseRefundCallback()`；
- 生产环境装配 `FakeProvider` 本身就是配置事故，装配层应该在 `NODE_ENV=production` 时拒启。

## 错误码

`PAYMENT_ERROR` 是 16（支付）域段的 7 位码表。目前它定义在本包而不是 `@taizan/contracts`：contracts 的内置 `ErrorCode` 还没有 16 段条目，而 `defineErrorCodes()` 只允许业务预留段 20–89。码值本身用 contracts 的 `buildErrorCode(ERROR_DOMAIN.PAYMENT, …)` 现算，与将来补进 contracts 的完全一致。

**后续动作**：把这张表原样搬进 `packages/contracts/src/error-codes.ts` 的内置表，然后本包改成引用它——三个 Error 子类不用变。在那之前，任何一端要判定支付错误码都从本包导入，不要写 magic number。
