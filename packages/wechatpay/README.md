# @taizan/wechatpay

微信支付协议层。**零框架依赖**：不 import nest / axios / prisma，不读 `process.env`，只用 `node:crypto`，HTTP 走注入的 `HttpClient`。整包可以在裸 node 下跑单测。

上层 Nest 装配（Provider registry、统一回调控制器、退款编排）见 `@taizan/nest-payment`。

## 目录

| 文件 | 内容 |
|---|---|
| `sign.ts` | V3 待签名串、`buildAuthorization`、`verifyResponseSignature`（平台证书 / 微信支付公钥双模式）、`signJsapi` 二次签名、nonce/时间戳、重放窗口 |
| `callback.ts` | 回调验签 → AES-256-GCM 解密 → 归一化为 `CallbackEvent` / `RefundEvent` |
| `sensitive.ts` | RSA-OAEP 敏感字段加密、`createFieldEncryptor`（同时给出 `Wechatpay-Serial`） |
| `types.ts` | 凭据、直连/服务商两种配置、`narrowWechatPayConfig`、`HttpClient` 与 `createFetchHttpClient` |
| `platform-pay.ts` | 直连/服务商的下单报文与路径构造（纯函数）、`trade_state` 映射 |
| `client.ts` | `WechatPayClient`：jsapi/native/h5 下单、查单、关单、退款、退款查询 |
| `profit-sharing.ts` | 分账：添加接收方、发起、查询、回退、查回退、查商户分账配置 |
| `transfer.ts` | 商家转账到零钱：发起前自查、报文、发起/查单/撤单、状态归并 |
| `applyment.ts` | 特约商户进件：表单 → 报文、图片上传 multipart、提交/查询 |
| `virtual.ts` | 小程序虚拟支付双 HMAC（`paySig` / `signature`）+ 环境与就绪判定 |
| `provider.ts` | `WechatPayProvider implements PaymentProvider`（channel `'WECHAT'`） |
| `fake-client.ts` | `FakeWechatPayClient`：假的只有网络那一层 |

## 用法

```ts
import {
  WechatPayClient,
  WechatPayProvider,
  createFetchHttpClient,
} from '@taizan/wechatpay'

const api = new WechatPayClient({ http: createFetchHttpClient() })
const provider = new WechatPayProvider({ api })

// cfg 由 @taizan/crypto 的 CredentialVault 按租户解密后传入，Provider 自身无状态
const res = await provider.createOrder(
  { outTradeNo, amountCents: 9900, description: '专业版 1 年',
    payer: { kind: 'openid', value: openid }, notifyUrl },
  cfg,
)
// res.payParams 是已二次签名的整包，原样下发前端，不许改任何一个字段
```

`cfg` 的形状（`narrowWechatPayConfig` 会逐字段校验，报错指到具体字段）：

```ts
// 直连商户
{ mode: 'DIRECT', appId, credentials: { mchId, serialNo, privateKeyPem, apiV3Key,
    publicKeyId?, publicKeyPem?, platformSerialNo?, platformCertPem? } }

// 服务商：credentials.mchId 是【服务商】商户号，签名用的也是服务商的证书私钥
{ mode: 'PARTNER', spAppId, subMchId, subAppId?, credentials: { … } }
```

## 几条用生产事故换来的约束

- **验签用的必须是原始报文字节**。拿到 body 对象再 `JSON.stringify` 回来是验签必挂的经典错误（键序和空白对不上）。Nest 侧要开 `rawBody: true`。
- **平台证书 / 微信支付公钥双模式**由回调头 `Wechatpay-Serial` 决定用哪一套；两套都没配 = 所有回调被拒，这是刻意的。序列号比较前会 `trim()`——env/header 里混进的不可见空白会让「看着一样却不相等」，那种问题看日志根本看不出来。
- **服务商模式**：`openid` 归属哪个 appid 就必须用对应字段（`sub_appid` → `payer.sub_openid`；服务商 appid → `payer.sp_openid`），搞反了微信直接拒单。退款只带 `sub_mchid`，带上 `sp_mchid` 会被判为多余参数。
- **分账标记只能下单时打**（`settle_info.profit_sharing`），事后无法补；但没开通分账时打了标记，钱会被冻到分账超时。
- **商家转账路径是 `/v3/fund-app/mch-transfer/transfer-bills`**，不是 `/transfers`；写错的表现是 404 且**没有 request-id**。这个接口不支持服务商模式。
- **进件图片上传的签名串正文是 `meta` JSON，不是 multipart 全文**——这是整个 V3 里唯一的例外，所以 `WechatPayCall` 有个 `signBody` 字段。
- **虚拟支付的 `env`**：0 = 正式，1 = 沙箱。两种环境都「成功」，沙箱只是钱一分没动且不报错。所以 `resolveXpayEnv()` 认不出一律当正式。

## 怎么加一个新支付渠道

本包是「按 `@taizan/payment-core` 的 `PaymentProvider` 写一个渠道」的参考实现。完整步骤见 `packages/payment-core/README.md` 的同名小节，这里只补三条从本包能抄的经验：

1. **协议层与网络层分开**。报文/路径构造放纯函数文件（本包的 `platform-pay.ts`），client 只剩「签名 → 发 → 验签 → 归一化」。好处是报文形状可以在没有网络的情况下逐字段断言。
2. **HTTP 用注入的接口**，别 import axios。超时、重试、代理是应用的事，不是协议层的事；而单测要能塞假实现。
3. **上游错误必须带上渠道自己的 code**。微信 4xx 的 body 是 `{code, message, detail}`，只记 HTTP 状态码的话，日志里剩一句「403」什么也查不出来；`request-id` 也要记——有它说明请求到了业务层（签名证书都没问题），没它多半是路径写错了。

## 怎么在 e2e 用 FakeProvider

e2e 用 `@taizan/payment-core` 的 `FakeProvider`（整个渠道都是假的，连微信的报文形状都不出现），用法见那个包的 README。

本包的 `FakeWechatPayClient` 是**给单测用**的另一档：只有网络那一层是假的，`WechatPayProvider` 的报文构造、二次签名、归一化仍然是真代码在跑。需要断言「发出去的报文长什么样」时用它：

```ts
import { FakeWechatPayClient, WechatPayProvider } from '@taizan/wechatpay'

const api = new FakeWechatPayClient()
const provider = new WechatPayProvider({ api })
await provider.createOrder(req, cfg)

api.lastCall('jsapi')?.payload   // 下单入参
api.calls                        // 全部调用流水
api.queryResult = { … }          // 预置查单结果
api.responses.set('POST /v3/profitsharing/orders', { order_id: 'O1' })  // 预置 call() 应答
```

回调这一侧不需要 fake：`callback.spec.ts` 里用与微信完全相同的算法（AES-256-GCM + RSA-SHA256）自己造报文，测的是真算法往返，而不是「自己解自己写的假数据」。

## 测试里的官方样例

两组必须保持绿的逐字节断言，签名出问题时**先跑这两组，再去怀疑别的**：

- `sign.spec.ts`：V3 文档「签名生成」的样例 `GET /v3/certificates` 待签名串，以及 `Authorization` 头的完整形状；
- `virtual.spec.ts`：虚拟支付文档 §2.6 的两组向量（`pay_sig=c37809f2…` / `signature=089d9e8d…`）。
