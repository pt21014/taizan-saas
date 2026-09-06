# 安全不变量对照表

这份文档回答一个问题：**框架里哪些东西是不能改的，改了会怎样，以及谁在拦。**

它不是「最佳实践建议」。下面每一条都来自 xiaodian / knowledge 两个线上项目踩过的坑——
`docs/框架设计蓝图.md` §9 把它们逐条落到了框架里，本文把每条展开成四栏：

| 栏 | 意思 |
| --- | --- |
| **不变量** | 一句话说清什么不能变 |
| **框架里由谁承接** | 具体的包 / 文件。改这件事只有这一个地方可改 |
| **违反时哪个 spec 会红** | 真实存在的测试文件路径。写「待补」的表示**目前没有机器守着，只能靠人** |
| **为什么** | 一句踩坑史。不写为什么的红线，三个月后就会有人「优化」掉 |

> **怎么读「待补」**：末尾第 6 节汇总了全部无 spec 守护的条目。这些是框架当前最脆的地方——
> 不是「不重要」，是「还没来得及写断言」。给框架提 PR 时，补一条这里的 spec 比加一个功能有价值。

跑全部架构约束测试：

```bash
pnpm -F @taizan/api test        # apps/api/test/arch/**（16 个 spec，不连库；见 docs/CI.md 第 4 节的最新条数）
pnpm test                       # turbo 全仓，含各包自己的 spec
```

---

## 1. knowledge `CLAUDE.md` 的 8 条硬性约定

### K1 · 多租户隔离

这一条在原项目里是一段话，落到框架里是四个独立的不变量，各有各的守卫。

| 不变量 | 框架里由谁承接 | 违反时哪个 spec 会红 | 为什么 |
| --- | --- | --- | --- |
| **K1.1 业务代码一律走 `prisma.tenant`，禁止手写 `tenantId` 过滤条件** | `@taizan/nest-prisma` 的 `createTenantExtension`（执行层）+ `apps/api/src/common` 的 `autoTenantData`（手写 tenantId 直接编译不过） | `apps/api/test/arch/no-manual-tenant-filter.spec.ts` | 问题不是「写了会错」，是**漏写不会报错**——漏写的那一个查询安静地返回全平台的数据，测试全绿、日志干净，只有商家会发现自己看到了别人的订单。 |
| **K1.2 隔离决策集中在一个纯函数里，未识别的操作失败关闭** | `@taizan/tenant-scope` 的 `planTenantScope`（零框架依赖，裸 node 可测） | `packages/tenant-scope/src/plan.spec.ts`（含「反面教材 ①②③」与「不可退让 ④：失败关闭」）、`packages/nest-prisma/src/extensions/tenant.spec.ts`、`packages/nest-prisma/src/no-bypass.spec.ts` | Prisma 升级后会冒出新操作名。放行未识别操作 = 新操作天然不隔离；抛错 = 升级当天就知道要补一行。这两种默认值的代价差着一次数据泄漏。 |
| **K1.3 新增带 `tenantId` 的表必须登记进 `TENANT_MODELS`** | `apps/api/src/tenancy/tenant-models.ts`（业务侧三行）+ `@taizan/prisma-base` 的 `createBaseRegistry`（框架 10 张预置） | `apps/api/test/arch/tenant-models.spec.ts`（双向比对 + 正则失效哨兵）、`packages/prisma-base/src/tenant-models.spec.ts`、`packages/tenant-scope/src/verify.spec.ts` | xiaodian 2026-08 的真实事故：加了张表忘了登记，那张表**完全没有隔离**，而且不报错。双向比对意味着「登记了但 schema 里没这列」也红——否则删表后清单会留一堆幽灵。 |
| **K1.4 `prisma.raw` 只允许三类场景，且每处写 `// raw-reason:`** | `apps/api/src/tenancy/raw-reasons.ts`（白名单 + 理由）+ `RawPrismaService` | `apps/api/test/arch/raw-usage.spec.ts` | 逃生口一旦「这次先用一下」，半年后全仓就都是 raw。三类场景是：登录跨租户找账号、支付回调按参数定位租户、平台后台——共同点是**此刻还没有 tenantId 可用**，不是「用 raw 方便」。 |

### K2–K8

| # | 不变量 | 框架里由谁承接 | 违反时哪个 spec 会红 | 为什么 |
| --- | --- | --- | --- | --- |
| **K2** | **金额一律 `Int` 且字段名以 `Cents` 结尾，禁用 `Decimal`** | 蓝图 §3.1 数据约定 + `@taizan/prisma-base` 的 `lintSchemaConventions` + `@taizan/contracts` 的 `formatCents` | `packages/prisma-base/src/schema.spec.ts`（「蓝图 spec 9：金额口径」，只扫框架片段）**+ `apps/api/test/arch/index.spec.ts`（spec 09，就地实现）**——后者的 `readSchemaFiles()` 默认扫 `apps/api/prisma/schema/**`，**含 `10-business/`**，业务片段与框架片段同一个 `lintSchemaConventions` 调用一起过 | 浮点存钱迟早对不上账，`Decimal` 则让「1.00 与 1.0 是不是同一个值」变成 ORM 与 DB 各答一次的问题。分是整数，整数没有这类问题。字段名带 `Cents` 是为了让 code review 时一眼看出单位——`price: 100` 到底是 1 元还是 100 元，靠猜就总有人猜错。 |
| **K3** | **`findUnique` 带 `select` 时必须包含 `tenantId`；权益/闸门判定收口一个服务** | `planTenantScope` 自动补 `select.tenantId`；权益侧是 `@taizan/nest-billing` 的 `PlatformGateway`（业务侧沿用「收口一个 `*.rules.ts`」的形状） | `packages/tenant-scope/src/plan.spec.ts`（「不可退让 ③：findUnique 自动补 select.tenantId」）、`packages/nest-billing/src/platform-gateway.spec.ts` | 归属校验读的就是 `tenantId`。`select` 里漏了它，校验拿到 `undefined`，于是**把自己的数据判成别人的、静默返回 null**——查询不报错，结果永远为空，商家报障说「我的数据没了」。 |
| **K4** | **敏感配置必须加密落库，接口只回脱敏值；每个 `*Enc` 列必须有配对的 keyId 列** | `@taizan/crypto` 的 `CredentialVault` + `TenantCredential` / `PlatformSetting` / `PlatformAdmin.mfaSecretEnc` 三张表 + `@taizan/nest-core` 的日志 redact | `packages/prisma-base/src/schema.spec.ts`（「蓝图 spec 11（前半）：加密列注册表 ↔ schema 对账」）、`packages/crypto/src/columns.spec.ts`、`packages/crypto/src/vault.spec.ts`、`packages/nest-core/src/logging/redact.spec.ts` | 明文落库的商户私钥，一次库备份泄漏就等于把收款权限送出去。没有 keyId 的密文在轮换到一半时**分不清新旧**，只能全量停机换——所以 keyId 是 xiaodian 那套的补丁，不是可选项。 |
| **K5** | **三套 JWT 密钥独立 + kind 校验；staff token 一次只绑一家店；每请求现查成员关系并用库里的角色覆盖 token 里的** | `@taizan/nest-auth`：`TokenService`（kind 不符直接拒）、`MembershipProvider`（30s 缓存）、`TokenTenantResolver`（优先级最高、不可被请求参数覆盖） | `packages/nest-auth/src/token/token.service.spec.ts`、`packages/nest-auth/src/membership/membership.provider.spec.ts`、`packages/nest-auth/src/tenant-resolver/tenant.middleware.spec.ts`、`apps/api/test/arch/tenant-middleware.spec.ts`；蓝图点名的 `staff-guard.spec.ts` **不存在 → 待补** | 整套隔离建立在「token 里的 tenantId 就是当前店」之上；改成按请求参数判断，隔离就从一条不变量退化成每个接口自己的事。而只信 token 里的角色，「移出店铺 / 停用 / 转让店主」这三件事在签发后**一周内都不生效，且都不报错**——最要命的是第三条：收款配置的钥匙在转让后还能被前任用一周。 |
| **K6** | **取客户端 IP 只能用 `resolveIps`，绝不能读 `x-forwarded-for` 第一段或 `req.ip`；限流三维度且入口/账号维度必须宽松** | `@taizan/ratelimit-core` 的 `resolveIps`（从 XFF **末尾**倒数 `TRUSTED_PROXY_HOPS` 段）+ `@taizan/nest-core` 的 `ip-resolver` + `@taizan/nest-auth` 在登录/验证码/注册处接线 | `apps/api/test/arch/ip-source.spec.ts`、`packages/ratelimit-core/src/resolve-ips.spec.ts`、`packages/ratelimit-core/src/decide.spec.ts`、`packages/nest-auth/src/ratelimit/ip-source.spec.ts`；线上另有 `deploy/checks/ratelimit-spoof-check.sh` | 链路是 客户端 → CDN → nginx → Node，nginx 用 `$proxy_add_x_forwarded_for` **追加**，所以 XFF 开头几段是客户端自己写的。knowledge 实测过：伪造后限流 key 直接变成伪造值，限流形同虚设。反过来，入口 IP / 账号维度收得太紧，攻击者就能用它锁死整片地区的用户或指定账号。 |
| **K7** | **微信网页授权 state 服务端签发 + 一次性核销 + 绑定租户；`redirect_uri` 的 host 用当前请求 Host 重建** | `@taizan/wechat-open` 的 `StateStore` 契约（32 字节随机、5 分钟 TTL）+ `@taizan/nest-infra` `CacheService.takeOnce`（GETDEL 原子核销） | `packages/wechat-open/src/oauth-state.spec.ts`、`packages/nest-infra/src/cache/cache.service.spec.ts`、`apps/api/test/arch/cluster-safe.spec.ts`（一次性凭据必须走 `takeOnce`，不许 `get` 后再 `del`） | 少了 state 校验，攻击者用自己账号的 code 拼个链接就能让用户**静默登录成他的账号**。核销不原子（先 `get` 后 `del`）在四进程下就是可重放窗口。host 不重建则是标准的开放重定向。 |
| **K8** | **响应统一 `{code,message,data}`：业务错误 HTTP 200 + 业务码，传输层错误走 HttpException 并同样包信封；逃生口是 `@RawResponse()` 而非硬编码路径** | `@taizan/contracts`（`ApiResponse` / 7 位错误码）+ `@taizan/nest-core` 的 `AllExceptionsFilter` + `TransformInterceptor` | `packages/contracts/src/response.spec.ts`、`packages/contracts/src/error-codes.spec.ts`、`packages/nest-core/src/http/all-exceptions.filter.spec.ts`；蓝图点名的 `response-shape.spec.ts`（全仓控制器返回形状的静态扫描）**已落地：`apps/api/test/arch/response-shape.spec.ts`**（登记在 `index.spec.ts` 的 `EXTRA_SPECS`），断言① 全仓控制器不许 `res.json(`/`res.send(` 绕过信封（`@RawResponse()` 路由与 `packages/nest-payment/src/notify.controller.ts` 除外，写了理由）② `throw new BizException(` 的首参不许是裸数字字面量 | 前端只想写一次剥包逻辑。混着两种形状的话，每个接口的调用点都要先判断「这个接口是哪一派的」。按路径前缀开逃生口的写法在 knowledge 试过：支付回调换了个前缀，回调返回值被包成信封，微信收到非 `SUCCESS` 于是**重推了 8 小时**。 |

---

## 2. knowledge 其他必须继承的约定

| 不变量 | 框架里由谁承接 | 违反时哪个 spec 会红 | 为什么 |
| --- | --- | --- | --- |
| **续费路径永远可写** | `@taizan/billing-rules` 的 `ALWAYS_WRITABLE_PREFIXES`（`/api/admin/auth`、`/api/admin/billing`、`/api/admin/bootstrap`）+ `isRenewalPath` | `apps/api/test/arch/billing-routes.spec.ts`（白名单 ↔ 真实 `@Controller` 前缀 ↔ 功能项 `pathPrefixes` 三方对账）、`packages/nest-billing/src/billing-routes.spec.ts`、`packages/billing-rules/src/renewal.spec.ts` | 「到期 → 后台只读 → 续不了费 → 永远到期」是个闭环死锁。它不会在开发环境出现（开发环境的租户永远没到期），只会在真实商家身上出现，而那时他连提工单的入口都在只读后台里。 |
| **到期永远现算，不落 `EXPIRED` 状态** | `TenantStatus` 枚举**刻意没有** `EXPIRED`；`evaluateTenantGate(now, planExpireAt, graceDays, …)` 每次请求现算 | `packages/billing-rules/src/gate.spec.ts`、`packages/billing-rules/src/period.spec.ts`；「schema 里不许出现 `EXPIRED` 枚举值」**已落地**：`packages/prisma-base/src/schema.spec.ts`（框架片段）+ `apps/api/test/arch/index.spec.ts`（spec 10，就地实现，扫 `apps/api/prisma/schema`）各加一条「`TenantStatus` 不得含 `EXPIRED`」的断言，均带哨兵（先确认 enum 真被解析到，再断言不含） | 落状态就要有人去改状态，于是需要一个 cron；cron 挂了或漏跑，一批租户就卡在错误状态里。现算没有这个失败模式，代价只是每次多算一次日期比较。 |
| **高风险开关默认关，并配套自检脚本** | `BILLING_ENFORCE` / `PAY_PROFIT_SHARING_ENABLED` 默认 `false`；`assertNoDevCodeInProd` 在生产检测到 `SMS_RETURN_DEV_CODE` / `WECHAT_DEV_FAKE_LOGIN` 等误配直接拒启 | `packages/nest-billing/src/env.spec.ts`、`packages/nest-core/src/config/assert-no-dev-code.spec.ts`；线上另有 `deploy/checks/billing-check.sh`（先回答「谁会被锁」） | 一个默认开的计费开关，上线当天会锁掉一批到期日填错的租户。默认关 + 照常计算 + 打 warn，让你能先看一眼名单再决定什么时候真拦。注意：冻结（`SUSPENDED`）与注销（`DEREGISTERED`）**不受这个开关管**——那是平台逐个按下去的。 |
| **三道闸门并列，不合并** | 套餐到期 `1440301`/`1440302`、配额超限 `1540301`、功能未含 `1540302` 是四个独立的码，分别由 `BillingGateGuard` / `QuotaService` / `BillingGateGuard` 抛 | `packages/billing-rules/src/gate.spec.ts`、`packages/billing-rules/src/quota.spec.ts`、`packages/billing-rules/src/feature.spec.ts`、`packages/contracts/src/error-codes.spec.ts` | 合成一个笼统的「无权限」之后，商家不知道该续费、升档、还是先删两个员工——唯一的下一步动作是打客服电话。判断该不该分码的标准只有一条：**用户的下一步动作是否相同**。 |
| **配额与功能都是三态：`null` ≠ `0` ≠ `[]`** | `checkQuota(limit: number \| null, …)`（`null`=不限量、`0`=一个都不给）、`hasFeature(features: string[] \| null, …)`（`null`=全部可用、`[]`=一个都不给） | `packages/billing-rules/src/quota.spec.ts`、`packages/billing-rules/src/feature.spec.ts` | 把 `null` 和 `0` 混成一个「假值」，结果是**给最贵套餐的商家配了 0 个员工名额**，或者反过来给试用租户开了无限量。DTO 上也要小心：`@Type` 会把 `null` 转成别的东西，「清空 = 不限量」必须能显式表达。 |
| **建租户只有一条路** | `@taizan/provision` 的事务编排；平台后台开通与 `/api/public/signup` 自助注册调同一个函数 | `apps/api/test/arch/provision-single-path.spec.ts`、`packages/provision/src/arch/single-path.scan.spec.ts`、`packages/provision/src/provision.spec.ts` | 两条路一定会漂。xiaodian 的表现是：自助注册建出来的租户**没有 owner 角色**，商家登录进去一个菜单都看不到——因为那条路径是后加的，忘了抄「建角色」那几行。 |
| **商业规则写成纯函数 + 单测** | `*.rules.ts` 约定（`goods.rules.ts` / `plan-order.rules.ts` / `signup.rules.ts` / `plan-lifecycle.rules.ts` 等）；`tools/codegen` 模板自带 | `apps/api/src/modules/example-goods/goods.rules.spec.ts` 等各模块自带；「规则必须是纯函数」**无静态强制 → 待补** | 规则埋在 service 里，就只能靠起 Nest + 连库 + 造数据才测得到，于是实际上没人测。到期日、按天折算、配额这类东西的边界条件（跨月、闰年、时区）只有纯函数测得起。 |

---

## 3. xiaodian 必须继承的条目

> 蓝图 §9 的小标题写的是「三条」，表里实际是 5 行。以实际 5 行为准。

| 不变量 | 框架里由谁承接 | 违反时哪个 spec 会红 | 为什么 |
| --- | --- | --- | --- |
| **全局 `APP_GUARD` 默认拒绝，`@Public()` 显式放行** | `@taizan/nest-auth` 的 `GlobalAuthGuard`，装在 `apps/api/src/bootstrap/global-providers.ts`（全仓唯一一处） | `apps/api/test/arch/guard-default-deny.spec.ts`、`packages/nest-auth/src/guards/default-deny.spec.ts` | 「忘了加守卫」的默认结果必须是拒绝。反过来的话，一个新控制器上线即裸奔，而且**代码 review 时看不出来**——因为缺的是一行不存在的代码。 |
| **`@Public()` 的路由必须同时声明 `@RateLimited(tier)`** | `guard-default-deny` 扫描器把「公开但无限流」判为失败 | `apps/api/test/arch/guard-default-deny.spec.ts` | 免登录接口是唯一能被无成本刷的入口。发短信验证码那种接口漏了限流，一夜的短信账单就能超过整月营收。 |
| **密钥轮换是一等公民：幂等、`--dry-run`、`--only`、三处对账** | `@taizan/crypto` 的 `planRotation` + `pnpm taizan:rotate-key`；keyId 多密钥（`CRYPTO_KEYS` + `CRYPTO_KEY_CURRENT`） | `packages/crypto/src/rotate.spec.ts`、`packages/crypto/src/cli/rotate-key.spec.ts`、`packages/crypto/src/columns.spec.ts`（注册表 ↔ schema ↔ 轮换脚本三处对账） | 轮换漏一列 = 换完密钥那一列**读不出来**，而且是在轮换完成、旧密钥已删之后才发现。幂等（按能否解密判定）是为了让轮换中断后能接着跑，而不是从头再来一遍双重加密。 |
| **env 用 zod 校验，启动即失败；生产禁止 dev 后门** | `@taizan/nest-core` 的 `defineEnvSchema` + `assertNoDevCodeInProd`；`.env.example` 由 schema 自动生成（`pnpm taizan:env-example`） | `packages/nest-core/src/config/define-env.spec.ts`、`packages/nest-core/src/config/assert-no-dev-code.spec.ts`、`packages/nest-core/src/config/env-example.spec.ts` | 缺一个环境变量，不该是「第一次用到那个字段时半夜炸」，而该是「启动时中文逐条列出来然后拒启」。`.env.example` 手写则必漏字段——漏的那个字段永远是新人第一天遇到的那个。 |
| **软删 extension 统一接管读**与**写**两条路径** | `@taizan/nest-prisma` 的 `createSoftDeleteExtension`（`delete` → `update`，读自动过滤）+ `apps/api/src/tenancy/tenant-models.ts` 的 `SOFT_DELETE_MODELS` | `packages/nest-prisma/src/extensions/soft-delete.spec.ts`、`apps/api/test/arch/tenant-models.spec.ts`（`SOFT_DELETE_MODELS` ↔ schema 的 `deletedAt` 列双向比对） | xiaodian 只接管了读：`delete()` 真的物理删掉行，而读路径看起来一切正常，于是「软删」这件事只有一半是真的。漏登记的表同理——不报错，只是数据没了。 |
| **`BizExceptionFilter` 区分 401（登出）与 403（仅提示）** | 7 位错误码的 HTTP 语义段直接表达；前端一行 `httpSemantic(code)` 分流 | `packages/contracts/src/error-codes.spec.ts`、`packages/admin-ui/src/request/create-request.spec.ts`、`packages/client-core/src/request.spec.ts` | 把 403 当 401 处理，商家会在续费页上被反复踢回登录——他越想付钱越付不了。 |

---

## 4. 框架自己新增的不变量

这些在两个老项目里都没有（或只有半套），是蓝图新加的。

| 不变量 | 框架里由谁承接 | 违反时哪个 spec 会红 | 为什么 |
| --- | --- | --- | --- |
| **cron 必须 `@LeaderCron`，禁止裸 `@Cron` / `setInterval`** | `@taizan/nest-infra` 的 `@LeaderCron`（Redis 锁 + 看门狗）+ `CronRun` 表作为可观测面 | `apps/api/test/arch/cluster-safe.spec.ts`、`packages/nest-infra/src/cluster-safe.spec.ts`、`packages/nest-infra/src/cron/leader-cron.spec.ts` | knowledge 的线上活故障：PM2 cluster 4 实例，到期提醒 cron 每天给同一个商家发 4 条短信。裸 `setInterval` 更糟——它连 `CronRun` 里都不留痕，只能靠商家投诉发现。 |
| **进程内 `Map`/`Set` 缓存必须标 `// process-local:` 理由** | `cluster-safe` 扫描器 | `apps/api/test/arch/cluster-safe.spec.ts` | 多实例下进程内缓存的失效是**只清本实例**的。这不一定是 bug，但必须是有意识的选择——写下理由这件事本身就能拦掉一半。 |
| **缓存 key 强制租户前缀 `t:{tenantId}:{ns}:{k}`** | `@taizan/nest-infra` 的 `CacheService`（非平台上下文缺租户前缀直接抛错） | `packages/nest-infra/src/cache/cache.service.spec.ts` | 缓存是隔离体系里最容易漏的一层：DB 查询隔离得好好的，结果 A 店读到了 B 店缓存里的结果。抛错比「悄悄用了全局 key」好。 |
| **队列 / cron 执行时必须重建上下文（新 traceId + `parentTraceId` + tenantId）** | `@taizan/nest-infra` 的 `JobEnvelope` + `runWithContext` | `packages/nest-infra/src/queue/queue.spec.ts`、`packages/nest-infra/src/queue/memory.driver.spec.ts` | 这是最常被漏的一处：异步任务里 `currentContext()` 是 `undefined`，于是 `prisma.tenant` 抛错、日志没有 traceId、审计写不进去。链回入队时的 traceId 是排障时唯一能把「用户点了个按钮」和「三分钟后队列里炸了」连起来的东西。 |
| **守卫链与拦截器链的顺序全仓只在一处定义** | `apps/api/src/bootstrap/global-providers.ts` | `apps/api/test/arch/guard-order.spec.ts`（逐项比对顺序，并断言除该文件外没有第二处 `APP_GUARD` / `APP_INTERCEPTOR`） | 顺序错了的表现是**放行**，不是报错：`BillingGateGuard` 排到认证前面会读不到 `principal.kind`，于是 `return true`，整条计费闸门静默失效，一条 e2e 都不会红。 |
| **权限点：代码注册表是唯一真源，双向对账** | `@taizan/nest-rbac` 的 `PermissionRegistry` + `apps/api/src/registry/permissions.ts`；DB 的 `Permission` 表只是镜像 | `apps/api/test/arch/permission-registry.spec.ts`、`packages/nest-rbac/src/arch/permission-registry.spec.ts` | 单向只能抓「拼错的 code」。反向（注册表里有、没人用）抓的是死权限——运营在角色页上勾了一个永远不生效的权限点，以为已经授权了。 |
| **菜单 `componentKey` 必须在前端映射表里有登记** | `apps/api/src/registry/menus.ts` + `@taizan/admin-ui` 的 `defineComponentMap` / `verifyComponentMap` | `apps/api/test/arch/menu-route-map.spec.ts`、`packages/nest-rbac/src/arch/menu-route-map.spec.ts`；**当前真源是 `apps/api/src/registry/component-keys.ts` 这份临时手写清单**（`apps/admin` / `apps/platform` 尚在建设中），换成扫前端 `component-map.ts` 前，这条守卫是**半真的 → 见第 6 节** | 漏一个 key 的表现是「菜单点进去白屏，控制台一句话都没有」——这种 bug 只会由用户报上来。 |
| **套餐订单只有一条兑现路径**（线上支付与「标记已付」共用 `markPaid` 事务） | `apps/api/src/modules/platform/plan-order/` | `apps/api/test/arch/plan-order-fulfill.spec.ts` | 同 provision 那条：另写一遍「续期 + 发资源 + 写审计 + 清缓存」，迟早少一步。少的那一步通常是清缓存，表现是商家付完钱 30 秒内还是只读。 |
| **`/api/public/*` 与 `/api/platform/*` 不进租户中间件** | `apps/api/src/tenancy/resolver.config.ts` 的 `TENANT_FREE_PREFIXES` | `apps/api/test/arch/tenant-middleware.spec.ts`（与真实控制器前缀比对） | 注册时店铺**还不存在**，租户中间件失败关闭会让注册接口 500。平台面天然跨租户，进中间件同理。 |
| **`prisma/schema/00-base/**` 是框架托管的，不许手改** | `@taizan/prisma-base` 的 `taizan-schema-sync` + `base.lock.json`（每片段 sha256 + 包版本） | `apps/api/test/arch/base-schema-integrity.spec.ts`、`packages/prisma-base/src/cli/sync.spec.ts` | 手改一行，下次 `schema-sync` 要么覆盖掉你的改动，要么冲突。真需要改的东西请提到框架去改，业务自己的列放 `10-business/`。 |
| **每个扫描型 spec 都必须带「正则失效防假通过」哨兵** | 各 spec 内置 + `@taizan/prisma-base` 的 `runSchemaLintSentinel` / `LINT_SENTINEL_SCHEMA` | `packages/prisma-base/src/schema-lint.spec.ts`（哨兵自测）、各 arch spec 自带 | 「扫不到东西」和「没有问题」在断言上长得一模一样。正则写坏之后，这些 spec 会**一直是绿的**，而且是最让人放心的那种绿。 |

---

## 5. 三个「不是不变量」的东西（免得被当成红线）

写清楚哪些**可以**改，红线才立得住：

- **`@RequirePermission` 不是必须的**。「默认拒绝」是认证层面的；权限判定没写就是不判定，否则每条「改自己密码」式的接口都要造一个假权限点。完整性靠 `apps/api/test/arch/permission-registry.spec.ts` 双向对账，不靠强制。
- **换店后旧 token 不吊销**（蓝图附录决策 5）。支持多标签各开一店，由 `exp` 兜底。要真踢人靠的是「每请求现查成员关系」。
- **平台超管目前是全权身份**。`PermissionsGuard` 对 `kind === 'platform'` 直接放行，约束靠「谁能拿到 platform token」+ `@Audit()` 全量审计。等 `RolePreset.side = 'PLATFORM'` 落地再改。

---

## 6. 待补清单（当前无 spec 守护）

按「补上它的收益」排序。每条都写清楚**建议放在哪、断言什么**，这样谁来补都不用再想一遍。

| # | 不变量 | 现状 | 建议 |
| --- | --- | --- | --- |
| 1 | 业务 schema 片段（`prisma/schema/10-business/**`）的金额 / 枚举 / 索引约定 | **已落地**：`apps/api/test/arch/index.spec.ts` 的 spec 09/10（就地实现）用 `readSchemaFiles()` 扫 `apps/api/prisma/schema/**`——该目录递归包含 `00-base/` 与 `10-business/`，两者拼成同一份 `PrismaSchemaAst` 后一起喂给 `lintSchemaConventions`，业务片段与框架片段受同一套断言 | 已完成，无需再补 |
| 2 | 「`TenantStatus` 里不许出现 `EXPIRED`」 | **已落地**：`packages/prisma-base/src/schema.spec.ts`（框架片段）与 `apps/api/test/arch/index.spec.ts` 的 spec 10（业务侧扫 `apps/api/prisma/schema`）各加一条断言，先确认 `TenantStatus` enum 真被解析到（哨兵），再断言其值集合 `not.toContain('EXPIRED')` | 已完成，无需再补 |
| 3 | 全仓控制器的返回形状 | **已落地**：新建 `apps/api/test/arch/response-shape.spec.ts`（登记进 `index.spec.ts` 的 `EXTRA_SPECS`，因为它对应蓝图 §9 而非 §8 的 16 条编号）。两条断言：① 全仓（`apps/api/src` + 全部框架包 `packages/*/src`）控制器不许 `res.json(`/`res.send(` 绕过信封，`@RawResponse()` 路由与 `packages/nest-payment/src/notify.controller.ts`（支付回调，整份文件白名单）除外；② `apps/api/src` 里 `throw new BizException(` 的第一个参数不许是裸数字字面量。均带哨兵样本 | 已完成，无需再补 |
| 4 | staff 守卫的完整行为 | **待补**：拆散在 `packages/nest-auth/src/membership/membership.provider.spec.ts`、`packages/nest-auth/src/token/token.service.spec.ts` 里，缺一条端到端断言：「库里 membership 为 `DISABLED` → 即使 token 有效也 401」。蓝图点名的 `staff-guard.spec.ts` 从未落地（**待补**） | 合并进 `packages/nest-auth/src/auth.integration.spec.ts` |
| 5 | 菜单 `componentKey` 的真源交接 | `apps/api/test/arch/menu-route-map.spec.ts` 当前比对的是 `apps/api/src/registry/component-keys.ts` 这份**手写清单**。`apps/admin/src/routes/component-map.spec.ts` 已经落地（T3-2 进行中），`apps/platform` 侧的还没有（**待补**，另有 agent 在推进 `apps/admin`/`apps/platform`，未在本次改动范围内）。手写清单留着，就永远有人只更新它而不更新前端，spec 会一直绿 | 给 `apps/platform` 也补一份同形状的 spec，把 arch spec 改成扫两份 `component-map.ts`，**删掉 `component-keys.ts`**（第三步是关键） |
| 6 | 「商业规则必须是纯函数」 | **待补**：各模块有 `apps/api/src/modules/example-goods/goods.rules.spec.ts` 这类单测，但没有任何断言强制「`*.rules.ts` 里不许 import Nest / Prisma」 | 一个正则扫描器即可，新建 `apps/api/test/arch/rules-purity.spec.ts`（**待补**，此路径当前不存在） |
| 7 | 「金额列在 DTO / VO 层也带 `Cents`」 | 只扫了 schema，没扫 `dto/*.ts` | 低优先级，但漏了会让前端在某一层开始猜单位 |

1–3 已经补完（本轮改动）。补完 4 之后，蓝图 §8 的 16 条会全部有真实文件对应——**16 条本身其实已经全部落地**（见 `docs/CI.md` 第 4 节），1–4 这几条补的是 §9「knowledge 8 条不变量」表里点名、但 §8 编号之外的额外缺口。当前 §8 对应情况见下表（**文件名以真实存在的为准**，蓝图里写的名字有几个从未落地）：

| 蓝图 §8 编号 | 蓝图写的名字 | 真实落在哪 |
| --- | --- | --- |
| 1 | `tenant-models.spec.ts` | `apps/api/test/arch/tenant-models.spec.ts` ✅ |
| 2 | `tenant-scope.spec.ts`（此名**待补**，从未落地） | 拆成 `packages/tenant-scope/src/plan.spec.ts` + `registry.spec.ts` + `verify.spec.ts` + `errors.spec.ts` ✅ |
| 3 | `raw-usage.spec.ts` | `apps/api/test/arch/raw-usage.spec.ts` ✅ |
| 4 | `no-manual-tenant-filter.spec.ts` | `apps/api/test/arch/no-manual-tenant-filter.spec.ts` ✅ |
| 5 | `guard-default-deny.spec.ts` | `apps/api/test/arch/guard-default-deny.spec.ts` ✅ |
| 6 | `permission-registry.spec.ts` | `apps/api/test/arch/permission-registry.spec.ts` ✅ |
| 7 | `menu-route-map.spec.ts` | `apps/api/test/arch/menu-route-map.spec.ts` ✅（真源待交接，见上表 #5） |
| 8 | `billing-routes.spec.ts` | `apps/api/test/arch/billing-routes.spec.ts` ✅ |
| 9 | `money-field.spec.ts`（此名**待补**，从未落地） | 并入 `packages/prisma-base/src/schema.spec.ts`（框架片段）✅ + `apps/api/test/arch/index.spec.ts` spec 09（业务片段 `10-business/` 现已覆盖，见上表 #1）✅ |
| 10 | `enum-and-key.spec.ts`（此名**待补**，从未落地） | 并入 `packages/prisma-base/src/schema.spec.ts`（含 `TenantStatus` 不许 `EXPIRED`）✅ + `apps/api/test/arch/index.spec.ts` spec 10（同上，含同一条 `TenantStatus` 断言）✅ |
| 11 | `credential-registry.spec.ts`（此名**待补**，从未落地） | 拆成 `packages/prisma-base/src/schema.spec.ts`（前半）+ `packages/crypto/src/columns.spec.ts`（后半）✅ |
| 12 | `cluster-safe.spec.ts` | `apps/api/test/arch/cluster-safe.spec.ts` ✅ |
| 13 | `ip-source.spec.ts` | `apps/api/test/arch/ip-source.spec.ts` ✅ |
| 14 | `provision-single-path.spec.ts` | `apps/api/test/arch/provision-single-path.spec.ts` ✅ |
| 15 | `base-schema-integrity.spec.ts` | `apps/api/test/arch/base-schema-integrity.spec.ts` ✅ |
| 16 | `tenant-middleware.spec.ts` | `apps/api/test/arch/tenant-middleware.spec.ts` ✅ |
| （新增） | —— | `apps/api/test/arch/guard-order.spec.ts`、`apps/api/test/arch/plan-order-fulfill.spec.ts` |

---

## 相关文档

- `docs/框架设计蓝图.md` §8（约束测试清单）、§9（对照表原文）
- `docs/EXTENSION-POINTS.md` — 加业务模块时这些不变量落到哪几个文件上
- `docs/ERROR-CODES.md` — 三道闸门各自的码
- `docs/templates/CLAUDE.md.hbs` — 生成项目的 CLAUDE.md 模板，本文的红线在那里以「给 AI 协作者的指令」形式再出现一次
