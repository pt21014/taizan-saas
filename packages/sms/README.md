# @taizan/sms

短信 Provider 接口 + registry（主厂商失败自动切备用）+ mock 兜底 + 模板契约；
腾讯云 TC3-HMAC-SHA256 与阿里云 RPC HMAC-SHA1 两套签名纯函数，各带官方文档
样例的逐字节比对测试。零框架依赖，只用 `node:crypto`，HTTP 走调用方注入的
`HttpClient` 接口，不 import axios。

## 怎么加一个短信厂商

1. 在 `src/providers/` 下新建一个文件，实现 `SmsProvider<TConfig>`：

   ```ts
   import type { HttpClient } from '../http-client'
   import type { SmsProvider, SmsResult, SmsSendRequest } from '../provider'

   export interface MyVendorConfig {
     apiKey: string
     templates: SmsTemplateRegistry
   }

   export class MyVendorSmsProvider implements SmsProvider<MyVendorConfig> {
     readonly name = 'my-vendor'
     constructor(private readonly http: HttpClient) {}
     async send(req: SmsSendRequest, cfg: MyVendorConfig): Promise<SmsResult> {
       // 1) 用 req.templateKey 从 cfg.templates 取 providerTemplateId + paramOrder
       // 2) 按厂商要求的算法签名（纯函数，单独导出，方便对着官方样例写 spec）
       // 3) this.http.post(...)，把响应归一化成 SmsResult；网络异常也要 catch 住，
       //    返回 { ok: false, error } 而不是抛出去——调用方要靠返回值决定扣不扣额度。
     }
   }
   ```

2. 签名算法一律先写成纯函数再包进 provider 类；对着厂商文档公布的官方样例写
   `*.spec.ts`。**如果文档把密钥打了码（`AKID****`）导致最终签名复现不出来**，
   参考 `tencent-tc3.spec.ts` 的做法：断言能独立复现的中间量（`CanonicalRequest`
   / `StringToSign` 的哈希），而不是硬编码一个记不准的最终签名。
3. 在 `src/index.ts` 里把新 provider 和它的 Config 类型导出。
4. 装配时 `registry.register(new MyVendorSmsProvider(http))`，需要降级就把它
   加进 `fallbacks` 数组——`sendWithFallback` 会在前一个失败时自动往后切。

## 关键约定

- **HTTP 客户端由调用方注入**：本包不 import axios、不直接用全局 `fetch`，
  这样签名纯函数能在裸 node 环境跑单测。`@taizan/nest-notify` 负责接上真实
  HTTP 客户端。
- **模板参数按位置传，不按对象键序**：两家厂商的模板都是 `{1}`/`${name}`
  占位符按顺序替换，`paramOrder` 显式声明顺序，`resolveTemplateParams` 缺
  变量就抛，不会把 `undefined` 悄悄拼进短信内容里发出去。
- **`SmsResult` 不抛异常**：网络异常、厂商拒绝都归一成 `{ ok: false, error }`，
  调用方（`@taizan/nest-notify` 或业务代码）靠这个决定要不要扣配额、要不要
  重试。
- **mock provider 生产环境启用直接拒启**：装配层在启动时调
  `assertMockNotInProd(env, enabledProviderNames)`，`NODE_ENV=production`
  时若 `mock` 出现在启用列表里就抛错——验证码被静默"发送成功"而用户收不到，
  这是要在启动那一刻就拦住的事故，不是运行时才发现的 bug。
