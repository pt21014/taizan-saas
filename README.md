# taizan-saas

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/pt21014/taizan-saas/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pt21014/taizan-saas/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)

**用来开发「平台向商家/门店/机构收年费、商家再服务自己的顾客」这类多租户 SaaS 的全栈 TypeScript 框架。**
一条命令生成一个完整项目：NestJS 后端 + 平台运营后台 + 商家后台 + C 端 H5/微信小程序 +
会员 App 与商家助手 App + 官网自助开店页。租户隔离、套餐计费与到期降级、三套身份与 RBAC、
微信支付与通知都已经接好，你只写自己的业务模块（商品、课程、预约……）。

形态是 **`create-taizan-saas` 生成器 + `@taizan/*` npm 包**。
本仓库自带七个可运行的端，它们既是参考应用（证明各包装得起来），也是生成器模板。
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

## 生成出来的系统：三类角色、七个端

| 角色 | 用哪个端 | 能做什么 |
| --- | --- | --- |
| **平台运营方**（你自己） | `platform` 平台后台（独立域名） | 开通/封停/注销租户，定套餐和价格，看订单与收入，标记线下收款、退款，发公告，看全平台审计日志，处理死信任务 |
| **商家**（店主 + 员工） | `admin` 商家后台；`app-merchant` 商家助手 App | 管员工与角色权限、看账单并自助续费、看操作日志与平台公告；日常业务页面由你的业务模块提供 |
| **C 端用户**（商家的顾客/会员） | `client`（Taro，一份代码出 H5 + 微信小程序）；`app-client` 会员 App | 进入某一家店浏览、登录、下单；店铺到期时看到打烊页 |
| 潜在商家 | `site` 官网 | 看产品与价格页，自助注册开店 |

七个端共用一个后端进程 `api`，按 URL 前缀分成 `/api/platform`、`/api/admin`、`/api/client`、`/api/public` 四个命名空间。
生成器可按需裁剪端：`full`（全部）、`api-only`、`api+admin`、`api+admin+platform`、`web`（三个 Web 端 + 官网）。

---

## 开箱即有的功能

标「包」的条目表示能力已在对应 `@taizan/*` 包里实现并有测试，但参考应用 `apps/api` 还没接出路由，需要业务项目按需装配。

**租户**
- 两条开通路径：官网自助注册（图形验证码、店铺路径查重与保留字、同 IP 限流）与平台后台代开通，二者走 `@taizan/provision` 同一条事务。
- 一号多店：一个手机号账号可属于多家店，登录时多店回选店列表，`POST /api/admin/auth/switch` 换店重签 token。
- 租户状态 `TRIAL / ACTIVE / SUSPENDED / DEREGISTERED`；平台侧可封停、恢复、续期、改套餐、重置店主密码、注销（保留期后由脚本列出待清理名单，不物理删表）。
- 租户解析：后台只认 token 里的 tenantId；C 端按 `X-Tenant-Slug` / 子域名解析，H5 支持 `/s/:slug` 路径，小程序支持启动参数与小程序码 `scene`。
- 行级隔离：租户表登记后由 Prisma 扩展自动注入 `tenantId`，漏登记在单测里直接红。租户级三方密钥（`TenantCredential`）加密落库。

**套餐与计费**
- 套餐：首开价与续费价分开、计费周期、配额、功能项、可接入的端；启用/停用/归档/排序。
- 订单：平台代下单、商家后台自助下单续费（拿微信支付参数）、线下收款「标记已付」、退款回退到期日；未支付订单 30 分钟自动关闭。
- 到期现算，不靠定时改状态：正常 → 宽限期（仍可写）→ 到期后**后台只读、C 端打烊**，续费入口（登录 / 账单 / bootstrap）永远可写。
- 配额（员工数、门店数、会员数、存储等维度，物化计数）与功能开关（可配「只拦写不拦读」），菜单随套餐裁剪。
- cron：到期提醒 T-7/T-3/T-1/T+0/T+3 五档（每档每天只发一次）、试用到期可自动转免费套餐、超时订单关闭。

**账号与权限**
- 三套身份：平台管理员 / 商家员工 / C 端会员，三套 JWT 互不通用；默认拒绝，公开接口必须显式 `@Public()` 且声明限流档位。
- RBAC：代码里注册权限点与菜单并同步进库，平台维护角色预设，商家自建角色；`@RequirePermission` 管接口，菜单按「权限 ∩ 套餐」裁剪后下发，按钮级权限。
- 数据范围：全店 / 本部门及下级 / 仅本人 / 自定义（`@DataScope()`）。
- 员工：邀请链接加入（扣员工配额）、停用/启用、转让店主；每个请求现查成员关系，被停用的员工下一个请求就失效。token 按 jti 吊销。
- 平台管理员 TOTP 二次验证：已有绑定与校验接口，登录时强制校验尚未接上。
- 限流：登录、注册、查询、公开接口分档，按客户端 IP、入口 IP、账号三个维度计数，IP 从 XFF 末尾倒数防伪造；Redis 不可用时退回进程内计数，不放行。

**支付**（`@taizan/wechatpay` + `@taizan/nest-payment`）
- 微信支付 V3：直连与服务商模式下单（JSAPI / Native / H5）、回调验签解密、退款；参考应用已用于套餐订单收款。
- 包：服务商分账、特约商户进件、商家转账到零钱、小程序虚拟支付签名。
- 统一回调入口 `/api/public/pay/*`：验签 → 幂等 → 归一化事件 → 领域处理器；本地用 Fake Provider 跑通全链路。
- C 端下单接口尚未提供，`client` 的下单页目前用模拟参数调起支付。

**微信生态**（包：`@taizan/wechat-open`）
- 开放平台第三方平台 token 链路、消息加解密、公众号来源优先级、网页授权 state 签发与核销、微信授权中转站扫码登录。

**通知**（`@taizan/nest-notify` + `@taizan/sms`）
- 四通道模板化发送，失败进队列重试、多渠道降级：站内信（已接）、短信（腾讯云 TC3 / 阿里云 RPC，主备切换，默认 mock）。
- 公众号模板消息、App 推送：通道接口已留，当前为空实现。

**存储**（包：`@taizan/storage`）
- 腾讯云 COS 公读、私读预签名、前端直传签名；VOD 上传签名；对象 key 强制带租户前缀。

**运维与审计**
- 审计：`@Audit()` 拦截器 + 手动记录，敏感字段脱敏，租户日志与平台日志分表。
- 队列：BullMQ，重试后落死信表，平台后台可查看与重放；cron 运行记录可查。
- 多实例安全：Redis 分布式锁（watchdog 续期）、`@LeaderCron` 保证 PM2 多实例下只跑一份、幂等键。
- `/health` 检查 DB 与 Redis；pino 日志带 traceId。
- 部署产物：Dockerfile、生产 docker-compose、PM2 配置、各端 nginx 配置、打包与迁移脚本；`deploy/checks/` 五个线上只读自检脚本（隔离、计费、限流伪造、health、cron 单实例）。

**现成页面**
- 平台后台：数据看板（概览 + 即将到期）、租户列表与详情、套餐、订单、角色预设、公告（按全体/套餐/指定租户/C 端投放，看已读）、平台管理员、审计日志、死信队列与 cron 记录。
- 商家后台：工作台、员工、角色权限、账单与续费、操作日志、平台公告、个人设置、邀请接受页，外加示例业务模块「商品」（增删改查、导出）。
- C 端：首页、商品详情、登录（开发期手机号登录；微信一键登录前端已写，后端未接）、下单确认、打烊页、店铺不存在页。商家助手 App 有登录、选店、看板、商品（只读）、设置；会员 App 有商品列表与详情、我的、打烊页。

**开发体验**
- `create-taizan-saas` 生成器：选端组合、业务域名称、MySQL 8 / PostgreSQL 16、支付与短信渠道。
- `pnpm gen:module <name>`：一次生成业务模块的表、隔离登记、权限点、菜单、套餐功能项、审计动作、队列任务七处，外加 rules 纯函数与 spec。
- 架构约束测试（`apps/api/test/arch/`）：漏登记租户表、裸 `@Cron`、公开接口无限流、菜单与路由对不上等，CI 直接红。
- 7 位错误码，文档由源码生成；设计 token 一处定义，同时输出 AntD 主题、Taro SCSS 与 RN 样式。

---

## 适用场景

| 场景 | 框架已经给你的 | 你还要写的 |
| --- | --- | --- |
| 连锁门店 / 餐饮会员与点单 | 每家店一个租户，店员分角色，按门店数/员工数定套餐，C 端小程序按店铺路径进店 | 菜品、桌台、点单、会员积分等业务表与页面；C 端下单接口 |
| 知识付费 / 课程平台 | 机构入驻与收费、COS/VOD 上传签名、小程序虚拟支付签名（iOS 合规）、到期打烊 | 课程、章节、学习进度、购买与发货逻辑 |
| 私域电商 / 小商城 | 商品示例模块可直接改造、微信支付与服务商分账、商家转账到零钱 | 购物车、订单、库存、物流、分销规则 |
| 预约类服务（美业、健身、家政、诊所） | 员工与数据范围（只看自己的客户）、短信与站内信通知、店铺级配额 | 服务项目、排班、预约与核销 |
| 多组织内部系统 | 组织即租户、RBAC 与数据范围、审计、平台统一开户 | 具体业务流程；不需要收费时关掉 `BILLING_ENFORCE`（到期闸门不再拦） |

**不太适合：**
- **单租户系统**：只有一个客户时，隔离、套餐、平台后台都是负担。
- **要求物理隔离的客户**：框架是共享库 + `tenantId` 行级隔离，不支持每租户一个库或一个 schema。
- **支付和登录不以微信为主**：内置的支付 Provider 只有微信支付，C 端围绕 H5/小程序/Expo；接支付宝、Stripe 或海外登录需要自己实现 Provider。
- **需要拆成多服务的超大规模系统**：后端是单个 NestJS 模块化单体。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 后端 | NestJS 11、Prisma 6、MySQL 8（生成时可选 PostgreSQL 16）、Redis（ioredis）+ BullMQ、zod、pino |
| 后台（商家 / 平台） | React 18、Vite、Ant Design 5、react-router 6、zustand |
| C 端 | Taro 4（H5 + 微信小程序）、Expo SDK 57（expo-router、React Native 0.86） |
| 官网 | React 18 + Vite，不用 UI 库 |
| 工程 | pnpm workspace、turbo、TypeScript、vitest、tsup、Changesets；Node ≥ 22 |

---

## 项目状态与路线图

目前处于 **0.x 早期阶段**：可发布的 `@taizan/*` 包与 `create-taizan-saas` 版本均为 `0.1.0`，尚未发布到 npm。

- **1.0 之前 API 可能有破坏性变更。** 每一次行为变更都通过 [Changesets](.changeset/README.md) 记录，
  版本号纪律与发布流程见 [`docs/RELEASE.md`](docs/RELEASE.md)，业务项目升级步骤见 [`docs/UPGRADE.md`](docs/UPGRADE.md)。
- 各能力的**安全不变量**已由 CI 断言，不属于「可能变」的范围：
  变的是 API 形状，不是 [`docs/SECURITY-INVARIANTS.md`](docs/SECURITY-INVARIANTS.md) 里的约束。

接下来要做的（欢迎认领）：

| 事项 | 现状 |
| --- | --- |
| 首次发布到 npm | `release.yml` 已就绪，待配置发布凭据 |
| C 端下单接口 | `client` 下单页目前用模拟参数调起支付 |
| C 端微信一键登录 | 前端已写，后端未接 |
| 平台管理员登录强制 TOTP | 绑定与校验接口已有，登录流程未强制 |
| 公众号模板消息、App 推送通道 | 通道接口已留，当前为空实现 |
| 微信开放平台、COS/VOD、分账、进件、商家转账接入参考应用 | 能力已在包里实现并有测试，`apps/api` 未接路由 |

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
| `tools/create-taizan-saas` | 生成器 CLI |
| `tools/codegen` | plop 模板，`pnpm gen:module <name>` 一次生成业务模块七处 |
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
│  ├─ app-merchant/ Expo 商家助手 App
│  └─ site/         官网：产品、价格、自助开店
├─ packages/        26 个 @taizan/* 包（见「能力总览」）+ _smoke 工具链样板包
├─ tools/           三个共享配置包 + 生成器 + codegen
├─ deploy/          Docker / PM2 / nginx / 部署脚本 / 线上只读自检
├─ docs/            蓝图、契约与红线文档（见 docs/README.md）
└─ scripts/         仓库级脚本（错误码生成、peer 依赖校验、changeset 检查、包内 LICENSE 同步）
```

`apps` 职责一句话：`api` 全部后端；`admin` 商家日常经营；`platform` 平台运营与收费；
`client` C 端触达；`app-*` 原生壳与推送场景；`site` 官网与自助开店。

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

[MIT](LICENSE) © 2026 钛赞
