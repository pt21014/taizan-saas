<!-- 本文件由 `node scripts/gen-error-codes.mjs` 生成，请勿手改。
     改错误码请改源码里的常量表，然后重跑 `pnpm docs:error-codes`。
     CI 跑 `pnpm docs:error-codes --check`，不同步就红。 -->

# 错误码总表

全仓共 **38** 个错误码，其中 **0** 个「待收编」（定义在各包内，尚未进 `@taizan/contracts` 的 `ErrorCode` 内置表）。

## 1. 编码规则（蓝图 §4.9）

7 位十进制：`DD HHH NN` = **域段 2 位 + HTTP 语义 3 位 + 序号 2 位**。

```
  1 4 4 0 3 0 1
  └┬┘ └─┬─┘ └┬┘
   │    │    └── 序号 01：这个域段里的第几个 403
   │    └─────── HTTP 语义 403：前端「只提示不登出」
   └──────────── 域段 14：计费与套餐
```

| 域段 | 含义 | 域段 | 含义 |
|---|---|---|---|
| `10` | 通用 / 参数 | `11` | 认证与会话 |
| `12` | 租户与隔离 | `13` | RBAC（权限点 / 数据范围） |
| `14` | 计费与套餐 | `15` | 配额与功能开关 |
| `16` | 支付 | `17` | 三方集成 |
| `18` | 队列与任务 | `19` | 平台运营 |
| `90` | 系统内部 |  |  |

`20–89` 全段留给业务项目，用 `defineErrorCodes()` 注册（它会拒绝 20–89 以外的域段，框架与业务永不撞码）。

## 2. 前端判定：只有一行

```ts
const httpSemantic = (code: number) => Math.floor((code % 100000) / 100)

switch (httpSemantic(code)) {
  case 401: clearSession(); gotoLogin(); break   // 清态跳登录
  case 403: toast(message); break                // 只提示，绝不登出
  case 429: toast("请求过于频繁"); break
  default:  toast(message)
}
```

**403 不能登出**：套餐到期（`1440301`）、配额超限（`1540301`）、无权限（`1340300`）都是 403，把它们当成 401 处理会让商家在续费页上被反复踢出登录。

**几个码刻意不合并**：`1440301`（去续费）/ `1540301`（升套餐或清理）/ `1540302`（套餐没含这个功能）/ `1340300`（找店主要权限）的下一步动作完全不同。合成一个笼统的「无权限」，商家只会来问客服。

## 3. 传输层兜底码：按规则现算，不入表

没有被任何业务码接管的 `HttpException`（守卫直接抛 `UnauthorizedException`、路由不存在、
body-parser 报 413 ……）由 `@taizan/contracts` 的 `transportErrorCode(status)` 现算一个码：

```ts
transportErrorCode = (status: number) => buildErrorCode(ERROR_DOMAIN.COMMON, status, 0)
// 401 → 1040100    403 → 1040300    404 → 1040400    413 → 1041300
```

即 **`10` 段 + HTTP 状态码 + 序号 `00`**。前端不需要为它特判：`httpSemantic()` 解出来就是原状态码。

**这不是给业务用的**。要区分「未登录」与「登录已过期」，请主动抛 `1140100` / `1140101`——
过滤器只看得见一个 401，猜不出是哪种。同理「租户不存在」请用 `1240400`，不要让它掉进 `1040400`：
两者前端处理完全不同（一个是页面 404，一个要提示换店）。

`1040000`（参数错误）与 `1042900`（请求过于频繁）在内置表里也各有一条同值常量——
不是撞码，是同一个码的两种到达方式，语义一致，刻意保持相等。

## 4. 全表

「状态」列：`✅ 已收编` = 在 `@taizan/contracts` 的 `ErrorCode` 里，四端可直接 import；
`待收编` = 暂时定义在各包内，引用时从该包 import，**不要抄字面量**。

### 域段 10 · 通用 / 参数

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1040000` | 400 | `ErrorCode.BAD_REQUEST` | 参数错误 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1042900` | 429 | `ErrorCode.TOO_MANY_REQUESTS` | 请求过于频繁，请稍后再试 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

<details><summary>本段各码的说明</summary>

- `1040000` **BAD_REQUEST** — 参数错误
- `1042900` **TOO_MANY_REQUESTS** — 请求过于频繁（限流命中）

</details>

### 域段 11 · 认证与会话

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1140100` | 401 | `ErrorCode.UNAUTHENTICATED` | 未登录 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1140101` | 401 | `ErrorCode.TOKEN_EXPIRED` | 登录已过期，请重新登录 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1140102` | 401 | `ErrorCode.TOKEN_KIND_MISMATCH` | 凭证类型不符 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

<details><summary>本段各码的说明</summary>

- `1140100` **UNAUTHENTICATED** — 未登录
- `1140101` **TOKEN_EXPIRED** — token 已过期
- `1140102` **TOKEN_KIND_MISMATCH** — token 类型（kind）与接口要求不符，例如拿 member token 打 admin 接口

</details>

### 域段 12 · 租户与隔离

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1240300` | 403 | `ErrorCode.CROSS_TENANT_FORBIDDEN` | 无权访问该租户资源 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1240400` | 404 | `ErrorCode.TENANT_NOT_FOUND` | 租户不存在 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

<details><summary>本段各码的说明</summary>

- `1240300` **CROSS_TENANT_FORBIDDEN** — 跨租户越权：token 所属租户与请求目标资源租户不一致
- `1240400` **TENANT_NOT_FOUND** — 租户不存在

</details>

### 域段 13 · RBAC（权限点 / 数据范围）

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1340300` | 403 | `ErrorCode.RBAC_FORBIDDEN` | 无权限 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1340301` | 403 | `ErrorCode.RBAC_DATA_SCOPE_MISCONFIGURED` | 数据范围配置错误 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

### 域段 14 · 计费与套餐

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1440301` | 403 | `ErrorCode.PLAN_READONLY` | 套餐已到期，后台暂只读，请续费 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1440302` | 403 | `ErrorCode.SHOP_CLOSED` | 店铺已打烊 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

<details><summary>本段各码的说明</summary>

- `1440301` **PLAN_READONLY** — 套餐到期，商家后台转只读（续费白名单路径永远可写）
- `1440302` **SHOP_CLOSED** — 套餐到期，C 端打烊

</details>

### 域段 15 · 配额与功能开关

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1540301` | 403 | `ErrorCode.QUOTA_EXCEEDED` | 已达到套餐配额上限 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1540302` | 403 | `ErrorCode.FEATURE_NOT_INCLUDED` | 当前套餐不包含该功能 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

<details><summary>本段各码的说明</summary>

- `1540301` **QUOTA_EXCEEDED** — 配额超限（`limit=0` 或 `used+delta>limit`）
- `1540302` **FEATURE_NOT_INCLUDED** — 当前套餐 features 不含该功能项

</details>

### 域段 16 · 支付

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1640000` | 400 | `ErrorCode.PAYMENT_BAD_REQUEST` | 支付参数错误 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1640001` | 400 | `ErrorCode.PAYMENT_SIGNATURE_INVALID` | 支付回调验签失败 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1640002` | 400 | `ErrorCode.PAYMENT_CALLBACK_PARSE_FAILED` | 支付回调解析失败 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1640003` | 400 | `ErrorCode.PAYMENT_ROUTE_NOT_FOUND` | 支付单号前缀未注册领域处理器 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1640004` | 400 | `ErrorCode.PAYMENT_PROVIDER_NOT_FOUND` | 支付渠道未配置 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1640005` | 400 | `ErrorCode.PAYMENT_CONFIG_INVALID` | 支付渠道配置不完整 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1640400` | 404 | `ErrorCode.PAYMENT_ORDER_NOT_FOUND` | 支付订单不存在 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1650000` | 500 | `ErrorCode.PAYMENT_UPSTREAM_ERROR` | 支付网关调用失败 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

<details><summary>本段各码的说明</summary>

- `1640000` **PAYMENT_BAD_REQUEST** — 通用支付参数错误（金额非法、outTradeNo 不合规等）
- `1640001` **PAYMENT_SIGNATURE_INVALID** — 回调验签失败（含序列号对不上、签名被伪造）。**绝不能落库**
- `1640002` **PAYMENT_CALLBACK_PARSE_FAILED** — 验签过了但报文解不开/字段缺失（解密失败、JSON 坏、algorithm 不支持）
- `1640003` **PAYMENT_ROUTE_NOT_FOUND** — outTradeNo 前缀没有注册领域处理器
- `1640004` **PAYMENT_PROVIDER_NOT_FOUND** — 该渠道没有装配对应的 Provider
- `1640005` **PAYMENT_CONFIG_INVALID** — Provider 配置缺字段/形状不对（narrow 失败）
- `1640400` **PAYMENT_ORDER_NOT_FOUND** — 查无此单
- `1650000` **PAYMENT_UPSTREAM_ERROR** — 上游支付网关报错/超时

</details>

### 域段 17 · 三方集成

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1740000` | 400 | `ErrorCode.WECHAT_TICKET_MISSING` | 尚未收到微信推送的 component_verify_ticket | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740001` | 400 | `ErrorCode.WECHAT_API_FAILED` | 微信开放平台调用失败 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740002` | 400 | `ErrorCode.WECHAT_TOKEN_INVALID` | 微信 access_token 已失效 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740003` | 400 | `ErrorCode.WECHAT_AUTH_CODE_INVALID` | 授权码校验失败，请重新发起授权 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740004` | 400 | `ErrorCode.WECHAT_MSG_DECRYPT_FAILED` | 微信消息解密失败 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740005` | 400 | `ErrorCode.WECHAT_RECEIVE_ID_MISMATCH` | 消息不属于本平台，已拒绝处理 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740006` | 400 | `ErrorCode.WECHAT_MSG_SIGNATURE_INVALID` | 微信消息签名校验失败 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740007` | 400 | `ErrorCode.WECHAT_UNSAFE_REDIRECT` | 回跳地址不合法 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740008` | 400 | `ErrorCode.WECHAT_UNSAFE_HOST` | 请求 Host 不合法 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740009` | 400 | `ErrorCode.WECHAT_STATE_INVALID` | 登录校验失败，请重新发起授权 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740010` | 400 | `ErrorCode.WECHAT_RELAY_FAILED` | 中转站登录失败，请稍后重试 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740011` | 400 | `ErrorCode.WECHAT_RELAY_SESSION_GONE` | 二维码已过期，请刷新重试 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740012` | 400 | `ErrorCode.WECHAT_MP_SOURCE_UNAVAILABLE` | 尚未配置微信公众号，无法完成微信登录 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |
| `1740300` | 403 | `ErrorCode.WECHAT_STATE_TENANT_MISMATCH` | 登录校验失败，请重新发起授权 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

<details><summary>本段各码的说明</summary>

- `1740000` **WECHAT_TICKET_MISSING** — 尚未收到微信推送的 component_verify_ticket
- `1740001` **WECHAT_API_FAILED** — 微信开放平台接口返回了 errcode
- `1740002` **WECHAT_TOKEN_INVALID** — access_token 失效（40001 / 42001），可自愈重试
- `1740003` **WECHAT_AUTH_CODE_INVALID** — 授权码校验失败
- `1740004` **WECHAT_MSG_DECRYPT_FAILED** — EncodingAESKey 配错 / 密文不合法
- `1740005` **WECHAT_RECEIVE_ID_MISMATCH** — 密文里的 receiveId 与本平台不符
- `1740006` **WECHAT_MSG_SIGNATURE_INVALID** — 消息签名校验不通过
- `1740007` **WECHAT_UNSAFE_REDIRECT** — 调用方给的回跳路径不安全（带 scheme / host / 协议相对）
- `1740008` **WECHAT_UNSAFE_HOST** — 当前请求的 Host 形状不合法，拒绝用它拼 redirect_uri
- `1740009` **WECHAT_STATE_INVALID** — state 不存在 / 已被用过 / 已过期
- `1740010` **WECHAT_RELAY_FAILED** — 中转站调用失败
- `1740011` **WECHAT_RELAY_SESSION_GONE** — 中转站会话不存在（sid 过期或已交付过 token）
- `1740012` **WECHAT_MP_SOURCE_UNAVAILABLE** — 一条公众号来源都不可用
- `1740300` **WECHAT_STATE_TENANT_MISMATCH** — state 绑定的租户与当前租户不一致（拿 A 店的 state 去 B 店换登录）

</details>

### 域段 18 · 队列与任务

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1850000` | 500 | `ErrorCode.JOB_REPLAY_FAILED` | 任务重放失败 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

### 域段 19 · 平台运营

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `1940400` | 404 | `ErrorCode.ANNOUNCEMENT_NOT_FOUND` | 公告不存在 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

<details><summary>本段各码的说明</summary>

- `1940400` **ANNOUNCEMENT_NOT_FOUND** — 平台公告不存在（已下架或 id 写错）

</details>

### 域段 90 · 系统内部

| 码 | HTTP 语义 | 常量 | 默认文案 | 定义处 | 状态 |
|---|---|---|---|---|---|
| `9050000` | 500 | `ErrorCode.INTERNAL_ERROR` | 系统内部错误 | `@taizan/contracts`<br/>packages/contracts/src/error-codes.ts | ✅ 已收编 |

<details><summary>本段各码的说明</summary>

- `9050000` **INTERNAL_ERROR** — 系统内部错误

</details>

## 5. 待收编清单

**（空）** —— 全仓每一个错误码的定义都在 `packages/contracts/src/error-codes.ts` 的 `ErrorCode` 内置表里。`@taizan/nest-rbac` 的 `RBAC_ERRORS`、`@taizan/payment-core` 的 `PAYMENT_ERROR`、`@taizan/wechat-open` 的 `WechatOpenErrorCode` 都只是内置表条目的别名（`FOO: ErrorCode.BAR`），不再各自 `buildErrorCode()` 一遍，所以也扫不出重复定义。

往下加码请**只改内置表**：包内那三张别名表要加条目，也是先在 contracts 定义、再在别名表里指过去。

## 6. 业务项目怎么加自己的码

```ts
import { defineErrorCodes } from '@taizan/contracts'

export const BizErrorCode = defineErrorCodes({
  GOODS_SOLD_OUT:   { code: 2040001, message: '商品已售罄' },
  GOODS_OFF_SHELF:  { code: 2040002, message: '商品已下架' },
})
```

三条纪律：

1. **域段必须落在 20–89**，`defineErrorCodes()` 会在模块求值时就抛错（不是等到第一次用）；
2. **HTTP 语义段要选对**：这一段决定前端行为，不是给人看的注释。业务上的「这个不让你干」写 403，别写 400；
3. **同一件事只给一个码**，不同的事一定分开。判断标准是「用户的下一步动作是否相同」——不同就必须分开。

---

本表由 `scripts/gen-error-codes.mjs` 扫描 `packages/*/src` 生成，扫不到的在脚本的 `MANUAL_ENTRIES` 里手工登记（当前 0 条）。传输层兜底码按规则现算，刻意不登记。
