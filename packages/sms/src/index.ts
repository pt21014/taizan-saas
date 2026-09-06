/**
 * `@taizan/sms`：短信 Provider 接口 + registry（主/备自动切换）+ mock 兜底 + 模板契约。
 *
 * 零框架依赖，只用 `node:crypto`；HTTP 一律走调用方注入的 {@link HttpClient}，
 * 本包不 import axios，也不直接用全局 `fetch`——这样签名纯函数可以在裸 node
 * 环境里跑单测，`@taizan/nest-notify` 则负责把真实 HTTP 客户端（比如 Node 18+
 * 内置 `fetch`）接进来。
 *
 * 最小用法：
 *
 * ```ts
 * import { AliyunRpcSmsProvider, SmsProviderRegistry, TencentTc3SmsProvider } from '@taizan/sms'
 *
 * const registry = new SmsProviderRegistry()
 *   .register(new TencentTc3SmsProvider(httpClient))
 *   .register(new AliyunRpcSmsProvider(httpClient))
 *
 * const { result, attempts } = await registry.sendWithFallback(
 *   { phone: '13800000000', templateKey: 'sms.login-code', params: { code: '1234' } },
 *   { 'tencent-tc3': tencentCfg, 'aliyun-rpc': aliyunCfg },
 *   { primary: 'tencent-tc3', fallbacks: ['aliyun-rpc'] },
 * )
 * ```
 *
 * @packageDocumentation
 */
export type { HttpClient, HttpResponse } from './http-client'
export type { SmsProvider, SmsResult, SmsSendRequest } from './provider'
export {
  SmsProviderRegistry,
  type SmsAttempt,
  type SmsFallbackOrder,
  type SmsSendOutcome,
} from './registry'
export {
  requireTemplate,
  resolveTemplateParams,
  type SmsTemplateDef,
  type SmsTemplateRegistry,
} from './templates'
export { assertValidCnPhone, isValidCnPhone, maskPhone } from './phone'

export {
  aliyunPercentEncode,
  aliyunRpcSignature,
  aliyunStringToSign,
  aliyunTimestamp,
  AliyunRpcSmsProvider,
  canonicalizedQuery,
  nonce,
  type AliyunSmsConfig,
} from './providers/aliyun-rpc'
export {
  tc3Authorization,
  TencentTc3SmsProvider,
  type Tc3Input,
  type TencentSmsConfig,
} from './providers/tencent-tc3'
export {
  assertMockNotInProd,
  MockSmsProvider,
  type MockSmsRecord,
  type ProdCheckEnv,
} from './providers/mock'
