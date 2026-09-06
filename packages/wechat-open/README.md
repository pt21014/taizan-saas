# @taizan/wechat-open

微信开放平台第三方平台 + 公众号登录的**纯逻辑层**。零框架依赖：只用 `node:crypto` 与注入的
`HttpClient`，不 import NestJS / ioredis / Prisma，也不 import `@taizan/contracts`。

这样切是因为它承载的全是**「错了不会报错」的逻辑**——加解密、签名、state 核销、来源优先级。
这类东西错了只会解出乱码、验签恒不通过、或者「看起来什么都没有」，而排查时人已经在怀疑
网络和配置了。所以它必须能在裸 node 里跑单测；一旦挂上框架，测试就要先起容器，
而那意味着这些用例迟早会被跳过。

## 三级 token 链路

```
       微信每 10 分钟主动 POST 过来（不是我们去拉）
                    │
                    ▼
        component_verify_ticket          ← TicketStore（加密落库）
                    │  api_component_token
                    ▼
        component_access_token（2h，平台级一份）   ← TokenCache（Redis，跨进程共享）
          │                 │
          │ api_create_     │ api_query_auth / api_get_authorizer_info
          │ preauthcode     │ api_authorizer_token
          ▼                 ▼
      pre_auth_code    authorizer_access_token（2h，每个商家一份）
      （30 分钟、       ← TokenCache，key 带 authorizer_appid
        一次性、        ← refresh_token 由 app 侧加密落库；
        不能缓存）         **微信可能下发新的，拿到就必须存**
```

三件从线上换来的经验，实现里都留着，`token-chain.spec.ts` 逐条盯：

1. **提前 5 分钟换新的**。卡在最后一秒刷新，并发请求里会有几个用到刚过期的 token。
2. **并发刷新搭同一趟车**。微信一签发新 token 就把旧的作废，两个并发的强刷会互相拆台，
   后换的把先换的换废——「刷新了反而更坏」。
3. **token 必须跨进程共享**。每个进程各取一份的话它们会互相把对方的作废，
   表现是接口**间歇性**报 40001，最难查的那种。

`component_verify_ticket` 是**推过来的**：开放平台后台的「授权事件接收 URL」没配好，
整条链路一个都拿不到，而现象只是接口报错。新部署最长要等 10 分钟才有第一个 ticket，属正常。

## state 为什么必须服务端签发

knowledge `CLAUDE.md` 第 7 条（蓝图 §9 不变量 7）：

> **微信网页授权的 state 必须服务端签发 + 回调核销**（随机 32 字节、5 分钟 TTL、一次性、
> 绑定租户），前端另存一份做本地比对。少了这层校验，攻击者用自己账号的 code 拼个链接
> 就能让用户静默登录成他的账号。同理，`redirect_uri` 只取调用方给的 path+query，
> host 一律用当前请求的 Host 重建，避免开放重定向。

拆开说是四件事，缺一件就等于没做：

| 要求 | 少了会怎样 | 本包对应 |
|---|---|---|
| 服务端签发 | 前端自己造的 state 谁都能造，等于没有 | `issueState()`，`randomBytes(32)` |
| 一次性核销 | 同一个 state 能重放，攻击者诱导商家走完授权就能把他的号挂到自己店下 | `consumeState()` → `OneTimeStore.takeOnce`（`GETDEL`，原子） |
| 绑定租户 | 拿 A 店的 state 去 B 店换登录 | payload 里存 `tenantId`；当前租户已知时再调 `assertStateTenant()` |
| host 用当前 Host 重建 | 开放重定向：`redirect_uri=https://evil.com/...` | `buildOAuthUrl()` 只收 `redirectPath`，host 走 `safeHost(requestHost)` |

`safeRedirectPath()` 对 `https://evil.com/x`、`//evil.com`、`/\evil.com`、`javascript:`、
带 `\r\n` 的一律**抛错**而不是「尽力修复」：能走到那儿的非法值不是代码写错就是有人在打我们，
两种都该在日志里留下痕迹。

两套 state**不要合并**（knowledge 里就是两个类）：

- **C 端登录**：租户是**输入**，核销后比对一致即可 → `consumeState` + `assertStateTenant`；
- **商家授权回调**：租户是**输出**——回调落在平台域上，没有店铺上下文，
  `state` 是「这次授权该落到哪个租户名下」的唯一依据 → 只 `consumeState`，不比对。

## 在 app 侧接上 nest-infra

本包只定义接口，生产实现由 app 侧适配（`@taizan/nest-infra` 的 `CacheService` 已经把
`takeOnce` 做成了 `GETDEL`）：

```ts
import { Injectable } from '@nestjs/common'
import { CacheService } from '@taizan/nest-infra'
import type { OneTimeStore, TokenCache, CachedToken } from '@taizan/wechat-open'

/** 一次性凭据：state。蓝图 §8 spec 12 要求这里必须是 takeOnce */
@Injectable()
export class RedisOneTimeStore implements OneTimeStore {
  constructor(private readonly cache: CacheService) {}

  async put(key: string, value: string, ttlSec: number) {
    await this.cache.set('wxoauth', key, value, ttlSec)
  }

  async takeOnce(key: string) {
    return this.cache.takeOnce<string>('wxoauth', key)
  }
}

/** token 缓存：component / authorizer 两级都用它 */
@Injectable()
export class RedisTokenCache implements TokenCache {
  constructor(private readonly cache: CacheService) {}

  async get(key: string) {
    return this.cache.get<CachedToken>('wxopen', key)
  }

  async set(key: string, token: CachedToken, ttlSec: number) {
    await this.cache.set('wxopen', key, token, ttlSec)
  }

  async del(key: string) {
    await this.cache.del('wxopen', key)
  }
}
```

包内自带 `MemoryOneTimeStore` / `MemoryTokenCache` / `MemoryTicketStore` / `MemoryRelaySessionStore`，
**只够单机与单测**。cluster 下用内存实现的后果是实测过的：pm2 开 4 个实例时
**四次登录里约三次失败**，而微信那边显示授权成功、浏览器也乖乖跳回了首页，只是人没登上。

`HttpClient` 也要 app 侧注入（`fetch` 包一层即可）。注意微信这套接口**永远回 HTTP 200**，
错误在 body 的 `errcode` 里，所以实现方把 JSON 原样返回就行，别「看到 200 就当成功」。

## 租户级密钥

商家自填的公众号 `appSecret`、中转站 `client_secret` **不由本包解密**：
app 侧用 `@taizan/crypto` 的 `CredentialVault` 从 `TenantCredential` 表解出明文后作为参数传入。
本包不认识 vault，也不该认识——「怎么解密」和「谁能解密」是两件事。

## 公众号四级来源

`resolveMpSource(candidates)`，优先级：
`TENANT_OWN`（租户自有）> `TENANT_AUTHORIZED`（租户授权给平台）>
`PLATFORM_AUTHORIZED`（平台代运营）> `PLATFORM_OWN`（平台自有，**需平台超管为这家店开通**）。

这套判定必须只有一份。三处都要用它——C 端登录、商家后台渠道页、取凭据的服务——
各写一遍不会报错，表现是「渠道页写着用平台的号而学员登不进来」，
或者「学员在商家的号里登录、通知却从平台号发出去」。

配套机器守卫：`scanDirectAppIdReads(srcDir, { allow })` 扫源码树，找出所有**直接读平台
appId/appSecret** 的地方；`assertMpSourceUsed({ srcDir, callers, delegators, allow })`
把「调用方必须调 resolveMpSource」「委托方不许自己再判一遍」「别处不许直接读平台凭据」
三条并成一个断言。业务项目照抄 `src/mp-source-usage.spec.ts` 改白名单即可。

## 中转站扫码登录

中转站（auth.taizan.vip）占掉公众号仅有的两个网页授权域名名额之一，再把授权结果转给挂在
它下面的每一个服务。商家只交 `client_id` / `client_secret`，**不必交出 AppSecret、
也不必改公众号的任何配置**。**只做登录**——中转站不给 access_token，
要凭据的地方（模板消息、分享签名）先用 `canIssueAccessToken()` 把它排除。

服务端会话签发的安全规则（都在 `relay-login.ts` 的 TSDoc 里）：

1. `poll_token` 与 `scene` **只留服务端**，前端只拿到我方发的 `sessionId`——
   只凭 poll_token 就能轮询的话，旁边拍到二维码的人就能顶掉这次登录；
2. ticket 一次性、60 秒过期，**兑换失败不重试**，让用户重扫；
3. **登录态是我方自己的**：中转站只回答「这是谁」，token 一律由本方服务端签发；
4. **token 只交一次**：终态交付后删会话，同一 `sessionId` 再问就是 `EXPIRED`；
5. 中转站抖动（超时 / 5xx / 认不出的状态）一律当 `PENDING`，别把一次网络抖动报成失败。

测试用包内的 `FakeRelayServer`（四态与错误码都能造），别各写一个假服务端。

## 导出一览

| 文件 | 内容 |
|---|---|
| `types.ts` | `ComponentConfig` / `AuthorizerInfo` / `MpSource` / 四个注入接口 |
| `errors.ts` | `WechatOpenError` + 17 域段错误码（**待补进 `@taizan/contracts`**） |
| `msg-crypt.ts` | AES-CBC + PKCS7(32) 加解密、sha1 签名、`openMsg()` 一步到位 |
| `ticket.ts` | 授权事件推送解析、`component_verify_ticket` 存储 |
| `component.ts` | `ComponentClient`：component token、预授权码、authorizer token 缓存 |
| `authorizer.ts` | `queryAuth` / `getAuthorizerInfo` / `refreshAuthorizerToken` / `componentSnsToken` |
| `mp-source.ts` | 四级优先级 + 两个机器守卫 |
| `oauth-state.ts` | state 签发核销、`safeRedirectPath` / `safeHost`、两个 URL 构造 |
| `relay-login.ts` | 中转站扫码 + H5，`RelayLoginClient` |
| `testing.ts` | `FakeRelayServer` / `FakeWechatOpenServer` |

回调控制器（走 raw 定位租户）不在本包，属 `apps/api/src/modules/public/wechat-open/` 的后续接线任务。
