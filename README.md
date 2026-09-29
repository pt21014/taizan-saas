# taizan-saas

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/pt21014/taizan-saas/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pt21014/taizan-saas/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)

**一套把多租户 SaaS 的「地基」做完的框架：新项目只写业务模块，隔离、计费、权限、支付、升级路径全都是既成事实。**

形态是 **`create-taizan-saas` 生成器 + `@taizan/*` npm 包**。
本仓库自带六个可运行的端，它们既是参考应用（证明各包装得起来），也是生成器模板。
框架升级靠改版本号，不靠复制粘贴。

taizan-saas 以 **MIT 许可证**开源，作为长期维护的项目运行。欢迎提 issue 报告问题、讨论设计，
也欢迎 PR——动手之前请先读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

设计细节见 [`docs/框架设计蓝图.md`](docs/框架设计蓝图.md)，文档索引见 [`docs/README.md`](docs/README.md)。

---

## 它解决什么

做第二个多租户 SaaS 时，真正花时间的不是业务，是这几件每次都要重做、而且**做错了不会报错**的事：

- 租户隔离——漏一个 `where` 条件，那个查询会安静地返回全平台的数据；
- 到期与配额闸门——「到期 → 后台只读 → 续不了费 → 永远到期」这种死锁只会出现在真实商家身上；
- 三套身份 + RBAC + 菜单下发——一号多店、换店重签、每请求现查成员关系；
- 密钥加密与轮换——漏一列，换完密钥那一列读不出来；
- 多实例安全——cron 跑 4 遍、限流被 XFF 伪造绕过。

框架把这些做成**不变量 + 静态断言**：不是文档里的建议，是 CI 里会红的测试。
完整清单见 [`docs/SECURITY-INVARIANTS.md`](docs/SECURITY-INVARIANTS.md)。

---

## 项目状态与路线图

目前处于 **0.x 早期阶段**：可发布的 `@taizan/*` 包与 `create-taizan-saas` 版本均为 `0.1.0`，尚未发布到 npm。

- **1.0 之前 API 可能有破坏性变更。** 每一次行为变更都通过 [Changesets](.changeset/README.md) 记录，
  版本号纪律与发布流程见 [`docs/RELEASE.md`](docs/RELEASE.md)，业务项目升级步骤见 [`docs/UPGRADE.md`](docs/UPGRADE.md)。
- 各能力的**安全不变量**已由 CI 断言，不属于「可能变」的范围：
  变的是 API 形状，不是 [`docs/SECURITY-INVARIANTS.md`](docs/SECURITY-INVARIANTS.md) 里的约束。

进行中：

| 事项 | 位置 |
| --- | --- |
| 生成器 CLI | `tools/create-taizan-saas` |
| 业务模块代码生成（plop 模板） | `tools/codegen` |
| 官网 + 自助注册 | `apps/site` |

---

## 能力总览

「零框架依赖」= 不 import `@nestjs/*` 与 `@prisma/client`，可在裸 node 里跑单测。
这是判定一个能力该不该抽成包的硬标准，也由 `pnpm check:peer-deps` 在发布前断言。

### 零框架依赖（14 个，低维护）

| 包 | 职责 |
| --- | --- |
| `@taizan/contracts` | 四端共用协议单一真源：`{code,message,data}` 响应包、**7 位错误码**、分页、ULID、菜单与权限下发 DTO、信封客户端 |
| `@taizan/tenant-scope` | 隔离**决策函数** `planTenantScope`、`TENANT_MODELS` 注册机、schema 双向比对器 |
| `@taizan/rbac-core` | 权限点表达式求值（`'a\|b'` 或 / `['a','b']` 与）、菜单树按 权限 ∩ 套餐 裁剪、数据范围判定 |
| `@taizan/billing-rules` | 到期现算、宽限期、只读/打烊三态、配额三态、功能开关、续费白名单 |
| `@taizan/ratelimit-core` | 三维度限流决策、`resolveIps`（从 XFF **末尾**倒数）、Redis 不可用时弱化不放行 |
| `@taizan/crypto` | AES-256-GCM + **keyId 多密钥** + 幂等轮换 + 加密列注册表 |
| `@taizan/provision` | 租户开通事务编排，**平台开通与自助注册共用唯一一条路** |
| `@taizan/payment-core` | 支付 Provider 统一接口、金额与 `outTradeNo` 规范、回调归一化事件 |
| `@taizan/wechatpay` | 微信支付 V3 签名/验签/回调解密/JSAPI 二签/服务商分账/特约商户进件/虚拟支付；`FakeWechatPayClient` |
| `@taizan/wechat-open` | 开放平台三级 token 链路、消息加解密、公众号四级来源优先级、网页授权 state 签发核销、中转站登录 |
| `@taizan/sms` | Provider 接口 + registry（主备切换）+ mock 兜底；腾讯 TC3 与阿里 RPC 两套签名 |
| `@taizan/storage` | 对象存储 Provider + 腾讯云 COS（公读/私读预签名/直传）+ VOD 签名 + **强制租户前缀** |
| `@taizan/prisma-base` | 框架 27 张基础表的 `.prisma` 片段、基础 `TENANT_MODELS`、`schema-sync` / `verify-schema` CLI、幂等 seed |
| `@taizan/tokens` | 设计 token 单一真源，三向映射到 AntD theme / Taro SCSS / RN |

### Nest 适配（9 个，真正有维护成本）

| 包 | 职责 |
| --- | --- |
| `@taizan/nest-core` | env zod 校验 + `assertNoDevCodeInProd`、全局异常 filter、响应拦截器 + `@RawResponse()`、AsyncLocalStorage 上下文、pino + traceId、`/health`、helmet/CORS、Swagger |
| `@taizan/nest-prisma` | `$extends` 三件套（租户 / 软删读写双向 / ULID）、`prisma.raw` 逃生口、乐观锁 |
| `@taizan/nest-auth` | 三套 JWT + kind 校验、全局默认拒绝 + `@Public()`、按 jti 吊销、refresh、**每请求现查成员关系**、换店重签、限流接线 |
| `@taizan/nest-rbac` | 权限点/菜单注册表、`@RequirePermission`、`@DataScope()`、菜单下发、注册表 → DB 同步 |
| `@taizan/nest-billing` | `PlatformGateway`（30s 缓存 + invalidate）、后台闸门与 C 端闸门、配额物化计数、`BILLING_ENFORCE` 总开关 |
| `@taizan/nest-infra` | BullMQ 队列（重试 + 死信落库）、Redis 分布式锁（watchdog）、**`@LeaderCron`**、幂等键、缓存（强制租户前缀）、`takeOnce` |
| `@taizan/nest-audit` | 审计动作常量、`@Audit()` 拦截器 + 手动 `record`、脱敏、租户/平台双表 |
| `@taizan/nest-notify` | 短信 / 站内信 / 公众号模板 / App 推送四通道，模板化、失败进队列重试、多渠道降级 |
| `@taizan/nest-payment` | Provider 装配与选路、统一回调控制器（验签 → 幂等 → 归一化 → 领域处理器）、退款编排、Fake provider |

### 前端（3 个）

| 包 | 职责 |
| --- | --- |
| `@taizan/admin-ui` | 后台基座：布局、登录与多店选择、**服务端菜单渲染**、权限路由、按钮权限、request 剥包、CRUD 表格表单 hooks、session store。一个业务页面 **41 行** |
| `@taizan/client-core` | Taro 侧：request 适配、tenant slug 解析、条件编译适配层（支付/分享/登录/选图）、打烊页与错误码处理 |
| `@taizan/app-ui` | Expo 双端：design token、组件、图表、`createApiClient`、SecureStore 会话、更新检查 |

### 工具

| 目录 | 内容 |
| --- | --- |
| `tools/tsconfig` / `tools/eslint-config` / `tools/prettier-config` | 三个共享配置包 |
| `tools/create-taizan-saas` | 生成器 CLI（**进行中**） |
| `tools/codegen` | plop 模板，`pnpm gen:module <name>` 一次生成业务模块七处（**进行中**） |
| `scripts/gen-error-codes.mjs` | 从源码生成 `docs/ERROR-CODES.md`；`--check` 供 CI |
| `scripts/check-peer-deps.ts` | 发布前闸门：断言零框架依赖包真的零框架依赖 |
| `deploy/checks/*.sh` | 线上只读自检：隔离 / 计费 / 限流伪造 / health / cron 单实例 |

---

## 10 分钟起步

前置：Node ≥ 22、pnpm 11、Docker。

```bash
# 1) 装依赖
pnpm install

# 2) 起基础设施：MySQL(宿主 3307) + Redis(宿主 6380)
#    端口刻意避开 MySQL/Redis 默认的 3306/6379，免得与本机已有服务冲突
pnpm dev:infra

# 3) 建表（第一次会生成 prisma/migrations/<时间戳>_init）
pnpm -F @taizan/api prisma:migrate

# 4) 造数据
pnpm -F @taizan/api seed
```

seed 出来的东西：平台管理员、两档套餐、两家演示店（其中 B 店**已到期**，是计费闸门的对照组）、
A 店一个「只有 `goods:list`」的受限员工、5 个示例商品，以及把权限点/菜单注册表镜像进 DB。

```bash
# 5) 起服务（三个终端，或用 pnpm dev 走 turbo）
pnpm -F @taizan/api dev          # http://localhost:3000 ，Swagger 在 /docs
pnpm -F @taizan/admin dev        # http://localhost:5173  商家后台
pnpm -F @taizan/platform dev     # http://localhost:5175  平台后台
```

### 三套身份怎么登录

| 身份 | 入口 | seed 出来的账号 | token 里有什么 |
| --- | --- | --- | --- |
| 平台超管 | `POST /api/platform/auth/login` | `admin` / `admin123` | `kind=platform`，**没有 tenantId** |
| 商家员工 | `POST /api/admin/auth/login` | `13800000000` / `123456`（A 店店主）<br/>`13800000001` / `123456`（B 店店主，**已到期**）<br/>`13800000002` / `123456`（A 店受限员工） | `kind=staff`，`tenantId` + `accountId` |
| C 端会员 | `POST /api/client/auth/login-dev` | 任意手机号（需 `CLIENT_DEV_LOGIN=1`，带 `X-Tenant-Slug: demo`） | `kind=member`，`tenantId` |

```bash
curl -s localhost:3000/api/platform/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}'

# 商家：名下多店时不发 token，回一张选店列表；带 tenantId 再打一次
curl -s localhost:3000/api/admin/auth/login -H 'content-type: application/json' \
  -d '{"phone":"13800000000","password":"123456"}'

curl -s localhost:3000/api/client/auth/login-dev \
  -H 'content-type: application/json' -H 'X-Tenant-Slug: demo' \
  -d '{"phone":"13700000001"}'
```

拿到 access 之后一律 `Authorization: Bearer <access>`。

### 验证一下框架真的在拦

```bash
pnpm -F @taizan/api test        # 单测 + 全部架构约束 spec（不连库）
pnpm -F @taizan/api test:e2e    # 隔离 e2e + RBAC/计费 e2e（连真库）
pnpm test                       # turbo 全仓
```

想看它拦什么，随便试一件：把 `apps/api/src/tenancy/tenant-models.ts` 里的 `'Goods'` 删掉，
再跑 `pnpm -F @taizan/api test` —— `tenant-models.spec.ts` 会红，并告诉你哪张表漏登记了。

停掉基础设施并**清空数据**：`pnpm dev:infra:down`。

---

## 仓库结构

```
taizan-saas/
├─ apps/
│  ├─ api/          NestJS 11 模块化单体，唯一后端进程，四命名空间
│  ├─ admin/        商家后台 React18 + Vite + AntD5
│  ├─ platform/     平台超管后台，独立应用独立域名
│  ├─ client/       Taro 一份代码编译 H5 + 微信小程序
│  ├─ app-client/   Expo C 端 App
│  └─ app-merchant/ Expo 商家助手 App
├─ packages/        26 个 @taizan/* 包（见「能力总览」）+ _smoke 工具链样板包
├─ tools/           三个共享配置包 + 生成器 + codegen
├─ deploy/          Docker / PM2 / nginx / 部署脚本 / 线上只读自检
├─ docs/            蓝图、契约与红线文档（见 docs/README.md）
└─ scripts/         仓库级脚本（错误码生成、peer 依赖校验、changeset 检查、包内 LICENSE 同步）
```

`apps` 职责一句话：`api` 全部后端；`admin` 商家日常经营；`platform` 平台运营与收费；
`client` C 端触达；`app-*` 原生壳与推送场景。官网 `apps/site` 仍在**进行中**。

各端与各包都有自己的 README，讲的是**这个包怎么用、哪里容易踩**，与本文不重复。
最值得先读的三份：[`apps/api/README.md`](apps/api/README.md)、
[`packages/prisma-base/README.md`](packages/prisma-base/README.md)、
[`packages/admin-ui/README.md`](packages/admin-ui/README.md)。

---

## 文档索引

| 文档 | 什么时候读 |
| --- | --- |
| [`docs/README.md`](docs/README.md) | 完整索引 |
| [`docs/框架设计蓝图.md`](docs/框架设计蓝图.md) | 想知道「为什么这么设计」 |
| [`docs/SECURITY-INVARIANTS.md`](docs/SECURITY-INVARIANTS.md) | **动隔离/计费/认证相关代码之前** |
| [`docs/EXTENSION-POINTS.md`](docs/EXTENSION-POINTS.md) | 要加一个业务模块 |
| [`docs/PLATFORM-SCHEMA.md`](docs/PLATFORM-SCHEMA.md) | 要加表、要知道框架表哪些字段不许改 |
| [`docs/ERROR-CODES.md`](docs/ERROR-CODES.md) | 前端要做错误分流，或要加自己的错误码 |
| [`docs/UPGRADE.md`](docs/UPGRADE.md) | 业务项目要升 `@taizan/*` 版本 |
| [`docs/RELEASE.md`](docs/RELEASE.md) | 要给框架发版 |
| [`docs/templates/CLAUDE.md.hbs`](docs/templates/CLAUDE.md.hbs) | 生成项目的 `CLAUDE.md` 模板（全部红线的可执行版） |

---

## 工具链

pnpm workspace + turbo 2.x + TypeScript 5.7+ + vitest 3.x + ESLint 9（flat config）+
Prettier（`semi: false, singleQuote: true, printWidth: 100`）+ tsup（ESM/CJS/d.ts）+
Changesets。Node ≥ 22。

新建一个 package 照抄 `packages/_smoke`（工具链样板包，不含业务逻辑，
专门用来证明 build/test/lint/typecheck 四件套跑得通），步骤在它的注释里。

国内网络下 `pnpm install` 慢的话，在 `.npmrc` 加 `registry=https://registry.npmmirror.com`。
本仓库默认保持官方源；`npm publish` 固定走官方源，与 install 的镜像无关。

---

## 参与贡献

开发环境、提交前必跑的检查、何时需要 changeset、改动安全相关代码的额外要求，
都在 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 安全问题

发现安全漏洞**不要开公开 issue**，按 [`SECURITY.md`](SECURITY.md) 走 GitHub 私密漏洞报告。

## 许可证

[MIT](LICENSE)
