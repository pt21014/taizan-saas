/**
 * `@taizan/wechat-open`：微信开放平台第三方平台 + 公众号登录的纯逻辑层。
 *
 * **零框架依赖**：只用 `node:crypto` 与注入的 {@link HttpClient}，不 import NestJS /
 * ioredis / Prisma / `@taizan/contracts`。所有 IO 收成四个接口注入：
 * {@link HttpClient}、{@link TokenCache}、{@link TicketStore}、{@link OneTimeStore}，
 * 包内自带内存实现（单机与单测够用），生产实现由 app 侧用 `@taizan/nest-infra` 适配。
 *
 * knowledge `CLAUDE.md` 第 7 条（本包的存在理由）：
 *
 * > **微信网页授权的 state 必须服务端签发 + 回调核销**（随机 32 字节、5 分钟 TTL、
 * > 一次性、绑定租户），前端另存一份做本地比对。少了这层校验，攻击者用自己账号的 code
 * > 拼个链接就能让用户静默登录成他的账号。同理，`redirect_uri` 只取调用方给的 path+query，
 * > host 一律用当前请求的 Host 重建，避免开放重定向。
 *
 * 租户级密钥（商家自填的公众号 appSecret、中转站 client_secret）**不由本包解密**：
 * app 侧用 `@taizan/crypto` 的 `CredentialVault` 从 `TenantCredential` 解出明文后作为参数传入。
 */

export * from './types'
export * from './errors'
export * from './msg-crypt'
export * from './ticket'
export * from './component'
export * from './authorizer'
export * from './mp-source'
export * from './oauth-state'
export * from './relay-login'
export * from './testing'
