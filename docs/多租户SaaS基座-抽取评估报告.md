# 多租户 SaaS 基座抽取评估报告

输入：本次盘点 `xiaodian-inventory.md` / `knowledge-inventory.md` / `reference-checklist.md`，以及两项目历史文档 `D:\project\xiaodian SAAS\docs\两套系统差异盘点.md`、`D:\project\knowledge\docs\共享底座-结论速览.md`、`共享底座方案.md`（写于 2026-07-27，schema 规模、短信、限流等结论已过时，本报告以本次盘点为准）。

---

## 0. 一页结论

1. **能抽，但能抽的不是一个框架，是三块形状完全不同的东西。** 真正可共享的只有：零框架依赖的协议/规则层（微信支付、短信签名、限流决策、隔离决策函数）约 3000 行；平台侧那 10 张表和配套模块的**代码模板**；以及一套约定。中间的 Layer 2（Guard/信封/审计）能抽成包，但必须先解决 Nest 10↔11、Prisma 5↔6 的双版本兼容。

2. **形态：依赖包 + 模板仓库结合，且比例是 3:7。** `@taizan/*` npm 包只装"不认识数据库"的部分；平台侧（租户/套餐/员工/权限/计费/审计的表 + Nest 模块 + 前端页面）走**模板仓库 copy-in**，因为它必须带 schema，而 `docs/两套系统差异盘点.md` 第二节算清的账仍然成立：xiaodian 全部 Int 自增、knowledge 全部 cuid，任何碰实体 id 的共享代码立刻分叉。

3. **历史文档"现在不要造框架"的判断需要修正一半。** 当时依据是"只有 2 个样本且互相矛盾"。现在样本仍是 2 个，但**矛盾点已经收敛**：隔离该用哪套（knowledge 失败关闭）、金额该用什么（Int 分）、状态该用什么（enum）都已有结论。剩下真正没收敛的只有主键类型一条——而这一条恰好就是"不共享 schema、只共享模板"的理由，不是"不抽"的理由。

4. **最大的三个缺口（两边都没有，基座必须新写）**：① **异步基础设施**——队列、分布式锁、分布式 cron 三件套全缺，knowledge 的 `order-close.service.ts`、`profit-sharing.service.ts`、`unfreeze.service.ts` 三个业务任务用裸 `setInterval` 且无任何锁或 leader 选举（已核实），而 `ecosystem.config.js` 是 cluster 4 实例，关单/分账/佣金解冻正在被并发跑 4 次；② **平台收费闭环**——xiaodian 的 `PlatformOrder.system_open/system_renew` 定义了无人生成消费，knowledge 的 `PlanOrder` 是线下转账后手工标记，两边平台侧收钱都靠人；③ **RBAC 与前端权限**——xiaodian 细粒度权限只是勾选 UI、落库展开回 21 个粗粒度点，knowledge 只有三级角色，两边前端菜单都硬编码，"角色-权限点-菜单-数据权限"四级一层都没有。

5. **起步顺序：先反哺，再抽包，最后做模板。** 第一阶段不做基座、做"把 knowledge 的失败关闭隔离层反向移植进 xiaodian"——这是唯一一件 1-2 周能做完、能让老项目立刻受益、且顺便产出基座第一个包的事（xiaodian 2026-08 已真实泄漏过一次）。

6. **绝对不要抽的**：业务层（课程/菜品/商品）、`libs/common` 里那 2000 行小票渲染与运费、`shop-page.ts` 1160 行装修 DSL、Store 表那 30+ 个餐饮字段。历史文档"Layer 4 是陷阱区"的结论完全成立，本报告不再讨论。

7. **一个非共识判断：后台前端框架的权限层应该"都不取、新写"。** xiaodian 菜单硬编码在 `MainLayout.tsx` 的 `menuData`、190 行路由表 85 条静态 import、`hasPerm()` 全项目零调用；knowledge 的 `apps.tsx` 菜单即数据但 `RequireAuth` 只查 token 存在。两边加起来也凑不出参考清单 P0 的"权限路由与后端权限点一一映射"。

---

## 1. 两个项目基座能力对照矩阵

| 能力 | xiaodian 现状 | knowledge 现状 | 基座取谁 | 理由 |
|---|---|---|---|---|
| 仓库结构 | Nest monorepo，`nest-cli.json`/`tsconfig.json`/`jest.config.ts` 三处需手工同步登记 | pnpm 11 + turbo 2.3，6 app / 2 package，turbo 只有 shared 一个真 build 节点 | **knowledge** | turbo + pnpm workspace 是通用形态；xiaodian 的 Nest monorepo 三处登记靠人记且无机器校验，是已知痛点 |
| 租户模型 | Tenant(品牌)→Store(门店)，Tenant 有 `expire_at`/`package_id`/`settings JSON` | Tenant(PENDING/ACTIVE/SUSPENDED，刻意无 EXPIRED、到期现算)+Shop 1:1，slug 全局唯一 | **knowledge** | "到期现算不落状态"避免了状态机与时间双真源；对外暴露 slug 而非内部 id。xiaodian 的 `settings JSON` 是业务杂物袋，不可移植 |
| 租户开通 | `libs/common/src/tenant/provision.ts` 147 行，泛型 tx 接口、不 import prisma 类型 | `modules/public/tenant-provision.service.ts`，三条开店路共用一个事务 | **xiaodian** | 147 行且刻意不 import Prisma 类型，注释写明"分开写过一次就会漂"——这就是基座要的形状，直接可搬 |
| 租户隔离 | `tenant.extension.ts` 仅 43 行，**两处失败开放**；且 `upsert` 落在 CREATE_OPS 里只改 `data`，而 upsert 的参数是 `{where,create,update}` 无 `data`，**扩展层对 upsert 零保护**（已核实：现有 9 处 upsert 调用全靠开发者手写 `tenant_id` 补救，违反项目"禁止手写 tenantId"的约定，且无测试守着） | `tenant-scope.ts` 225 行纯决策函数，双重失败关闭，`upsert` 显式分支处理（L211），`findUnique` 自动补 `select.tenantId` | **knowledge** | 已核实：xiaodian 扩展体量 43 行 vs knowledge 225 行，差的正是 upsert、findUnique、AND 包裹这些"不报错的错"。这是全报告最硬的一条 |
| 隔离机器守卫 | `__tests__/tenant-scoped-models.spec.ts` 单向对账，无隔离行为单测 | `tenant-models.spec.ts` 双向比对+正则失效哨兵、`tenant-scope.spec.ts` 20 it、`tenant-middleware.spec.ts` 扫 forRoutes | **knowledge** | 三道守卫 vs 一道，且 knowledge 有行为单测 |
| 认证/会话 | 三套 JWT 独立密钥 + 全局 APP_GUARD + `@Public()` 退出；Redis 多会话按 jti 单端吊销；**无 refresh token** | 三套 JWT + kind 校验，但逐控制器 `@UseGuards`；StaffAuthGuard 每请求现查成员关系（30s Map 缓存）用库里角色覆盖 token；滑动续期 | **合并：xiaodian 骨架 + knowledge 现查** | xiaodian 的"默认关、显式开"少漏；knowledge 的现查成员关系解决了无状态 token 撤权延迟。两者互补且不冲突，`session.service.ts` 与 `staff-account.service.ts:225` 各取一半 |
| 多店切换 | `login/choose` + chooseToken + `/auth/switch` 换 token；`BrandSwitcher` 整页重载 | StaffAccount(phone 全局唯一)/Staff(成员关系) 拆表 + `/admin/auth/switch` 重签 + `ShopSwitcher` 整页重载 | **knowledge** | 拆表模型更干净（一号多店是表结构表达的，不是 token 技巧）；两边前端都是"重签+整页重载"，一致 |
| RBAC | `PERMS` 21 点 + `@RequirePermission` + `PermissionsGuard`(带单测) + `StoreScopeGuard`；但细粒度目录只是勾选 UI，落库展开回粗粒度；平台侧 super 直接 return true | 仅 `StaffRole{OWNER,ADMIN,EDITOR}` + `@Roles`(84 处) 内联在 Guard 里，无独立 RolesGuard | **都不取、新写** | xiaodian 的是"半个"（细粒度不生效、平台侧短路），knowledge 的是"三分之一"。参考清单 P0 要求角色-权限点-菜单-数据权限四级，两边加起来也不够 |
| 平台管理面 | 13 个模块：租户 CRUD/启停/续期/重置密码、套餐、应用目录、角色预设、审计查询、跨租户看板、告警 cron、平台素材、短信计费；**无平台管理员 CRUD、无公告** | 11 个控制器：租户 CRUD/冻结/清空数据、按人管账号+分组、套餐+订阅订单、服务费额度、分成收入、资源包、装修模板、AI 配置 | **xiaodian 为主，knowledge 补计费页** | xiaodian 模块划分更完整（角色预设、审计、告警 knowledge 全无）；knowledge 的"按人管账号+分组"和额度页 xiaodian 没有，补进来 |
| 套餐/配额/到期 | 套餐=一组 `app_keys`（功能门控），`entitlement.ts` 79 行；**零数量配额**；到期只在商家登录时拦（`auth.service.ts` L154/293/364），已发 token 照用，C 端不受影响，无 cron 无提醒无降级 | Plan 带配额（`null`≠`0` 三态）；到期即后台只读 + C 端打烊 + 7 天保留；`billing.rules.ts` 273 行 + 414 行单测；`BILLING_ENFORCE` 总开关默认关 + `billing-check.sh` 预演 | **合并：xiaodian 的 app_keys 模型 + knowledge 的闸门规则** | 这是两文档一致认定的"最有价值的互补"。功能门控和到期配额是两个正交维度，基座两个都要 |
| 平台收费闭环 | `PlatformOrder.type` 定义 `system_open`/`system_renew` 但**无代码生成或消费**，实际线下收钱+运营手工 extend；唯一打通的是短信套餐 | `PlanOrder` 半自动：线下转账→平台标记已付 | **都不取、新写** | 两边都没有真正的"下单→支付→自动续期→开票"闭环。这是 P0 缺口，见第 2 节 |
| 第三方密钥加密 | AES-256-GCM 存 `*_enc` 列 + `rotate-crypto-key.ts` 幂等轮换(支持 `--dry-run`/`--only`，覆盖 9 列) + `credential-registry.spec.ts` 三处对账 | `infra/crypto.service.ts` 42 行 AES-256-GCM，零耦合；`tenant-cloud.service.ts` 的"要么全用商家的"策略 | **xiaodian** | 加密本身两边等价（都是 42/33 行），差距在**轮换与对账**：xiaodian 有幂等轮换脚本 + 三处清单对账测试，knowledge 完全没有。密钥轮换是一等公民这条要带进基座 |
| 微信支付协议层 | `sign.ts` 159 / `applyment.ts` 160 / `platform-pay.ts` 45 / `types.ts` 130，**已核实零 nest/prisma import**；有 `FakeWechatPayClient` 195 行 | `v3-sign.ts` 125 行 + 211 行单测（含官方样例逐字节比对）；虚拟支付双 HMAC；混在 service 里未分层 | **xiaodian 骨架 + knowledge 测试** | 分层已经在 xiaodian 那边做好，不用先重构；但唯一能证明实现没跑偏的官方样例比对在 knowledge。历史文档这条判断经复核仍然正确 |
| 微信开放平台 | 代上传/提审/发布 + 消息加解密 + token 刷新 cron，`libs/wechat` 1912 行 | ticket→component→authorizer 三级 + `msg-crypt.ts`；`resolveMpSource` 公众号四级来源优先级；中转站登录 | **knowledge** | 三级 token 链路和四级来源优先级是把"多租户下代运营谁的号"这件事表达清楚了；xiaodian 的更偏小程序代开发单场景 |
| 短信 | `libs/sms` 735 行：provider 接口 + registry + 阿里云实现 + **mock 兜底**（只打日志）+ 模板表 128 行 | `infra/sms/sign.ts` 双厂商 TC3/RPC 纯函数签名 | **xiaodian 抽象 + knowledge 签名** | xiaodian 有 provider/registry/mock 三件套（这是参考清单里"多渠道降级"的地基），knowledge 有第二家厂商的签名实现。合起来正好是一个可用的抽象 |
| 对象存储 | `libs/cos` 93 行，**无 provider 抽象、无预签名、无私有读**，租户目录前缀在调用方拼 | COS 公读 / 私读音频 / VOD 直传 + Key 防盗链 + `vod-sign.ts`（官方样例单测） | **knowledge** | 93 行 vs 完整的公读/私读/直传/防盗链。xiaodian 这块几乎是空的 |
| 统一响应/错误码 | `{code,msg,data}`，6 位纯域段；拦截器**硬编码** `/api/wechat\|delivery\|alipay/` 白名单 | `{code,message,data}`，5 位借 HTTP 语义；`@RawResponse()` 装饰器逃生口 | **knowledge** | `message` 字段名 + `@RawResponse()` 装饰器（而不是硬编码路径前缀）两点都更对。错误码编号方案见第 3 节，两边都不直接取 |
| env 校验 | zod 62 项启动即失败，JWT≥32 位、CRYPTO_KEY 强制 64 hex，`assertNoDevCodeInProd()` 生产检测到 `SMS_RETURN_DEV_CODE=1` 直接拒启 | **完全没有**（ConfigModule 未配 validationSchema），缺密钥运行期才炸 | **xiaodian** | `libs/config/src/env.schema.ts` 114 行，`assertNoDevCodeInProd` 把免密后门在启动期堵死。这是基座标配 |
| 日志/traceId | pino + redact 脱敏 + Sentry；但 traceId 在 ContextMiddleware 生成后**未注入 pino 的 genReqId**，日志里搜不到 | **无结构化日志、无 traceId、无落盘、无 Sentry**，4 进程下无法追溯单次请求 | **xiaodian（但要修）** | xiaodian 有 80% 且断了最后一环，knowledge 是 0%。基座里补 genReqId + 队列/cron 的 traceId 注入 |
| 限流 | 只有 app-api 有、只按 IP；merchant/admin 零限流，后台登录可无限撞库 | `RateLimitService` 181 行三维度（客户端 IP/入口 IP/账号），`resolveIps` 从 XFF **末尾**倒数取，Redis 降级为弱化不放行，215 行单测 + `ratelimit-spoof-check.sh` | **knowledge** | 差距悬殊。XFF 从末尾倒数这条是实测绕过后改的，属于"踩过才知道"的知识 |
| 缓存/Redis | `libs/redis` 54 行薄封装，**无分布式锁、无缓存抽象、无 key 命名空间** | `infra/redis.service.ts` 薄封装 + `takeOnce`(GETDEL 原子核销) | **knowledge 打底、新写抽象** | `takeOnce` 值得直接搬（一次性凭据的正确形状，且有 `cluster-safe-store.spec.ts` 守着）；但"租户前缀 key + 分层缓存 + 分布式锁"两边都没有，要新写 |
| 队列 | **无 BullMQ**，退款失败、webhook 失败均无重试（ROADMAP 已自认） | **无**，分账/转账/短信/通知要么同步要么轮询 | **都不取、新写** | 两边都是零 |
| 定时任务 | `@nestjs/schedule` 15 个 cron，靠 PM2 fork 单实例保证不重复（`ecosystem.config.cjs` 注释写明），横向扩容即双跑 | 7 处裸 `setInterval`，**无 leader 选举无锁**，线上 4 实例 cluster 正在并发跑 4 次 | **xiaodian 打底、新写锁** | xiaodian 至少用了框架且把约束写进注释；但两边都没有分布式调度。knowledge 这条是**当前线上真实故障面**，见第 2 节 P0 |
| 审计日志 | `libs/audit` 327 行，235 个动作常量、418 处手动调用 | **完全没有**（schema 无 AuditLog，已核实），而平台侧有冻结租户、清空数据、改密、手工加减额度、转让店主这些高危操作 | **xiaodian** | 唯一实现。但手动调用 418 处的形状要改成拦截器+装饰器，见第 3 节 |
| 健康检查 | 三份雷同的 `{status:'ok'}`，不探 DB/Redis | 未见独立实现 | **都不取、新写** | 参考清单 P1 明确要求探 DB/Redis 连通性。当前 PM2/Nginx 探活等于没探 |
| 前端后台框架 | ProLayout mix 布局；`request.ts`+`envelope.ts` 拆信封、100003/100007 清 token；菜单硬编码在 `MainLayout.tsx`；无路由守卫、无懒加载、145 个 tsx 手写 Table | `http.ts` 拦截器 + `session.ts` 收口"我是谁在哪家店" + `apps.tsx` 菜单即数据 + `ShopSwitcher`；`RequireAuth` 只查 token 存在；`api/index.ts` 1526 行单文件 | **knowledge 骨架 + 新写权限层** | `session.ts` 和 `apps.tsx`（菜单即数据）方向对，直接可搬；权限路由、按钮级权限、通用列表页 hook 两边都没有，新写 |
| 官网模板 | 无 | `apps/site` 零 UI 库 11 页（Home/Pricing/Features/Solutions/Faq/Legal/Start...），`NAV`/`BRAND`/site-config 兜底渲染 | **knowledge** | 已核实 11 个页面文件齐全，零依赖，直接当模板 |
| 小程序/H5 模板 | 原生微信/支付宝/抖音三份小程序（各写一遍） | Taro 4.0.9 一套编译 H5+小程序，26 页 | **knowledge** | 参考清单 P0 明确要求 Taro 统一构建；xiaodian 三份原生正是要避免的形态 |
| App 模板 | RN/Expo 店务助手 | Expo 57 + RN 0.86 双端（app-student 5 屏 / app-merchant 7 屏）+ `packages/app-ui` 1216 行提供 token/组件/图表/`createApiClient`/SecureStore | **knowledge** | 有共享 UI 包和 `createApiClient`，是"模板"；xiaodian 的是一个具体 App |
| 测试策略 | 36 单测 + **90 e2e**（testcontainers 起真 MySQL+Redis） | 111 spec，几乎全是 `*.rules.spec.ts` 纯函数 + 扫源码静态断言两类；无 e2e，靠 11 个线上只读自检 `.sh` | **两者都要** | 不是二选一：纯函数单测 + 源码对账（knowledge）守约定，e2e（xiaodian）守链路，线上自检脚本（knowledge）守生产。基座模板三种各给一个样例 |
| 部署脚本 | 宝塔+PM2 fork 单实例+Nginx 配置齐全，tar 增量上传，流程写在 HANDOFF.md | pm2 cluster 4 实例 + nginx 三站同源反代 + EdgeOne；36 个 deploy 脚本（11 个线上只读自检）；`migrate deploy` 线上跑不通，靠手写幂等 SQL | **xiaodian 模板 + knowledge 自检脚本** | xiaodian 的 ecosystem/nginx 更规范；knowledge 的自检脚本范式（`tenant-isolation-check` / `billing-check` / `ratelimit-spoof-check`）是反向输出候选 |
| CI | **无**（无 .github） | **无**，且无 ESLint、prettier 装了无配置文件等于没生效 | **都不取、新写** | xiaodian 至少有 eslint（`no-explicit-any: error`）可当基座 lint 基线，但流水线两边都是零 |

---

## 2. 对照参考清单的缺口

只列真正缺的。"两边都无"=基座必须从零写；"两边都弱"=有雏形但达不到验收点；"一边有但不可移植"=需重写落库/框架层。

| 能力 | 优先级 | xiaodian | knowledge | 缺口性质 | 基座里怎么补 |
|---|---|---|---|---|---|
| 队列（重试/死信） | **P0** | 无 | 无 | 两边都无 | `@taizan/queue`：BullMQ 薄封装，约定 job 名带租户前缀、统一重试策略与死信落库。**不补的后果**：微信支付回调、退款、分账、短信全无重试，失败即丢——xiaodian ROADMAP 已自认这笔债 |
| 分布式锁 + 分布式 cron | **P0** | 靠 PM2 fork 单实例，扩容即双跑 | 7 处裸 setInterval，4 实例并发跑 4 次 | 两边都弱（knowledge 是**线上活故障**） | `@taizan/lock`：Redis SET NX PX + 看门狗续期；`@taizan/scheduler` 用锁包住每个 cron tick。**不补的后果**：knowledge 的关单/分账轮询/佣金解冻当前正在重复执行，`order-close.service.ts:21` 的注释与线上 cluster 配置已经不一致 |
| 幂等键 | **P0** | 无统一机制 | 无统一机制（`takeOnce` 只覆盖一次性凭据） | 两边都无 | `@taizan/idempotency`：`(scope, key)` → Redis 占位 + DB 落表双层。**不补的后果**：微信回调必然重复推送，重复发货/重复退款 |
| 数量配额 | **P0** | 完全没有（门店/员工/商品上限全无） | Plan 有配额且 `null`≠`0` 三态 | 一边有但不可移植（`checkQuota` 缠在 billing service 里） | 把 knowledge 的配额规则重写为纯函数 `@taizan/billing-rules`，落库计数留在各项目。**不补的后果**：xiaodian 套餐只能卖"功能"不能卖"规模"，无法做分档定价 |
| 到期→通知→宽限→降级 | **P0** | 只在登录时拦，已发 token 照用，C 端不受影响，无 cron 无提醒 | 到期即只读+C 端打烊+7 天保留，但**无到期前 N 天通知** | 两边都弱 | knowledge 的闸门规则进基座；通知链路用 xiaodian 的 `libs/sms`+`notification`。**不补的后果**：xiaodian 一个 8 小时的 staff token 就能绕过到期；商家在完全不知情的情况下被打烊，续费转化崩 |
| 平台收费闭环（账单/欠费/冻结） | **P0** | `PlatformOrder.system_open/system_renew` 定义了无人生成消费 | `PlanOrder` 线下转账+手工标记 | 两边都弱 | 基座出 `PlanOrder` 表 + 下单/支付回调/自动续期/欠费状态机模板。**不补的后果**：平台侧收入全靠运营手工 `extend`，租户数上百后必然漏收错收 |
| RBAC 权限点+菜单+数据权限 | **P0** | 细粒度目录只是勾选 UI，落库展开回 21 个粗粒度点；平台侧 super 短路 | 只有三级角色 | 两边都弱 | 新写：权限点常量 → 角色 → 菜单树 → 行级数据范围四张表 + 单个 `PermissionsGuard` + 前端菜单由后端下发。**不补的后果**：参考清单明确"前端菜单隐藏不能替代后端接口级校验"，xiaodian 前端 `hasPerm()` 零调用正是这个反例 |
| 缓存抽象 + 租户前缀 key | **P0** | 无抽象无命名空间 | 只有薄封装 + `takeOnce` | 两边都弱 | `@taizan/cache`：key 强制 `t:{tenantId}:{ns}:{k}`，未带租户前缀的 key 在非平台上下文直接抛错（照抄隔离层的失败关闭思路）。**不补的后果**：缓存漏加 tenantId = 跨租户脏读，且不会报错 |
| traceId 全链路 | **P0** | 生成了未注入 pino | 无日志无 traceId | 两边都弱 | pino `genReqId` 接 AsyncLocalStorage，队列 job 与 cron tick 各自开新 traceId 并记父 id。**不补的后果**：knowledge 4 进程下单次请求不可追溯，出问题只能猜 |
| 租户注销与数据保留 | **P0** | 只有启停 | 有 SUSPENDED 和平台侧"清空数据" | 两边都弱 | 状态机加 `DEREGISTERED` + 保留期字段，物理删除只允许过期后由脚本执行。**不补的后果**：参考清单红线"禁止物理删表"，knowledge 平台侧的"清空数据"按钮当前无审计无保留期 |
| 支付网关 Provider 抽象 | **P0** | 微信/支付宝各写一套，无统一接口 | 只有微信 | 两边都无 | `@taizan/payment-core` 定统一 Provider 接口（下单/回调解析/退款/查单），微信、支付宝、抖音各出适配包 |
| 审计日志 | **P0** | 有（327 行，418 处手动调用） | **完全没有** | 一边有但需重写 | 表结构+动作常量取 xiaodian，调用方式改成 `@Audit()` 装饰器 + 拦截器（418 处手动调用不可持续）。**不补的后果**：knowledge 平台侧冻结租户/清空数据/改密/加减额度全部无痕 |
| 软删唯一索引维度 | **P0** | extension 统一接管读，但**不管写**；58 处 `deleted_at` | 只有 3 处手写过滤 | 两边都弱 | 软删 extension 取 xiaodian 并补写路径；约定所有业务唯一索引必须带 `deleted_at`（否则软删后无法重建同名数据），配源码对账测试 |
| Refresh Token | **P0** | 无，靠长 exp（member 7d/staff 8h/admin 4h） | 滑动续期，无独立 refresh | 两边都弱 | 短 access(15min) + refresh 落 Redis 可吊销。**不补的后果**：xiaodian member 的 7 天 token 一旦泄漏无法在 7 天内失效 |
| 租户审核与实名 | **P0** | 只有微信支付服务商进件 `applyment.ts` | 无 | 两边都弱 | 基座出审核状态机 + 资质附件表；企业核验/人脸核身留插件点 |
| 健康检查探活 | P1 | 三份 `{status:'ok'}` | 无 | 两边都弱 | `@taizan/health`：DB/Redis/队列三项探测，Nginx/PM2 按真实结果摘流量 |
| 乐观锁 | P1 | 无 | 无 | 两边都无 | 约定余额/库存/额度类表加 `version`，基座提供 `updateWithVersion` 辅助 |
| 试用与防重复开通 | P1 | 无 | 无 | 两边都无 | 试用状态 + 手机号/主体维度去重表 |
| CI | P1 | 无 | 无 | 两边都无 | GitHub Actions：lint + 单测 + `prisma migrate diff` dry-run + 租户越权专项用例强制跑 |
| 邀请与成员管理 | P1 | Staff 由 owner 直接建 | StaffAccount/Staff 拆表但无邀请流 | 两边都弱 | 邀请码/链接 + 待激活状态 + 移除成员的数据归属规则 |
| 工单/客服 | P1 | 无 | 无 | 两边都无 | 平台侧模板模块，附带租户上下文一键拉取 |
| 发票 | P1 | 无 | 无 | 两边都无 | 先做人工开票工单流转 |
| 代码生成器 | P1 | 11 个 seed 脚本，无生成器 | 无 | 两边都无 | plop 模板内置 tenantId 过滤 + 权限装饰器 + 对应 spec |
| 一键初始化 CLI | P1 | 无 | 无 | 两边都无 | `create-taizan-app`，验收=生成后可跑通登录+建租户+一个示例 CRUD |
| 多环境隔离 | P1 | 单套 .env | 单套 .env | 两边都弱 | `.env.{env}` + 三方配置（appid/商户号）按环境分离 |
| 公告/站内信 | P2 | 无（xiaodian 有告警通知但非广播） | 无 | 两边都无 | 平台→租户→C 端三级广播表 |
| Webhook/开放 API + API Key | P2 | 无 | 无 | 两边都无 | 依赖队列先落地，再做回调重试与死信 |
| SSO（平台跳商家免登） | P2 | 无 | 无 | 两边都无 | 一次性短票据（可直接用 knowledge 的 `takeOnce`） |
| 设计 Token 共享包 | P2 | 无 | `app-ui` 有 token 但只覆盖 RN | 一边有但不完整 | 从 app-ui 提取 token 层，映射到 AntD 与 Taro |

---

## 3. 基座形态与包结构建议

### 3.1 形态决策：依赖包 + 模板仓库，3:7

结论：**`@taizan/*` npm 包只做 Layer 0-2，平台侧（Layer 3）做模板仓库 copy-in。**

三条已核实的硬约束：

1. **主键类型不可统一**。xiaodian 103 model 全 Int 自增 + 94 迁移，knowledge 105 model 全 cuid + 77 迁移，存量都改不动。包里只要出现 `id: number` 或 `id: string` 就废掉一半下游，所以包必须停在"不认识数据库"那一层。
2. **框架双版本**。Layer 0-1 零依赖不受影响；Layer 2 必须把 Nest/Prisma 放 `peerDependencies` 声明 `^10 || ^11` / `^5 || ^6`，且**必须有两个版本各跑一遍的 CI matrix**，否则第一次升级就分叉。
3. **平台侧必须带 schema**。Prisma 多文件 schema 虽支持 include，但迁移仍要在每个项目各跑一遍，主键类型不统一时片段根本不通用。所以平台侧走模板 copy-in，基座只保证"新项目起步时是对的"。

**引用与升级**：Layer 0-2 走公开 npm（协议层无商业秘密，而两边都在宝塔服务器上跑 `pnpm install`，私有包要配凭据且要轮换）；下游**锁死版本号不用 `^`**；Layer 3 模板更新只发 CHANGELOG，**明确接受分叉**——这是换取"不用同步 schema"付的代价。

### 3.2 包清单

| 包名 | 职责 | 来源 | 零框架依赖 | 预估行数 |
|---|---|---|---|---|
| `@taizan/wechatpay` | V3 签名/验签/回调解密/JSAPI 二签/RSA-OAEP 敏感字段/服务商下单分账报文/特约商户进件 | 骨架取 xiaodian `libs/wechatpay/src/{sign,applyment,platform-pay,wechatpay-callback,types}.ts`（159+160+45+111+130=605 行，已核实零 nest/prisma）；测试取 knowledge `v3-sign.spec.ts` 官方样例逐字节比对 | ✅ | 700 + 400 测试 |
| `@taizan/wechat-open` | 开放平台三级 token 链路（ticket→component→authorizer）纯逻辑 + `msg-crypt` AES 消息加解密 + 四级来源优先级 | knowledge `infra/wechat-open/`、`resolveMpSource` | ✅ | 500 |
| `@taizan/sms` | Provider 接口 + registry + mock 兜底 + 模板定义；阿里云 RPC 与腾讯 TC3 两套签名 | 抽象取 xiaodian `libs/sms/`（735 行）；TC3 签名取 knowledge `infra/sms/sign.ts` | ✅ | 600 |
| `@taizan/storage` | 对象存储 Provider 接口 + COS 实现（公读/私读预签名/直传）+ VOD 签名 + 防盗链 Key + 强制租户前缀 | knowledge `infra/tencent/{vod,tc3}-sign.ts` + storage service；xiaodian `libs/cos` 93 行不要 | ✅ | 500 |
| `@taizan/crypto` | AES-256-GCM 加解密 + keyId 多密钥支持 + 轮换算法（幂等、按能否解密判定） | xiaodian `libs/common/src/utils/crypto.ts`(33) + `scripts/rotate-crypto-key.ts`；**新增 keyId**（两边都只有一把全局密钥） | ✅ | 250 |
| `@taizan/tenant-scope` | 租户隔离**决策函数**：给定 (model, operation, args, tenantId, 模型清单) 返回 ScopePlan；双重失败关闭 | knowledge `apps/api/src/infra/tenant-scope.ts` 225 行（已核实含 upsert 显式分支 L211、findUnique 补 select） | ✅ | 250 + 300 测试 |
| `@taizan/ratelimit` | 三维度限流决策 + `resolveIps`（XFF 末尾倒数 N 段）+ Redis 降级为弱化不放行 | knowledge `common/rate-limit.{service,config}.ts` 296 行 + 215 行单测 | ✅ | 350 + 250 测试 |
| `@taizan/billing-rules` | 到期/只读/打烊/宽限期判定、配额三态（`null`≠`0`）、插件门控、`app_keys` 门控 | 闸门规则取 knowledge `billing.rules.ts`(273)+`credit.rules.ts`(359)+`plan-feature.ts`(203)；`app_keys` 概念取 xiaodian `entitlement.ts`(79) | ✅ | 700 + 700 测试 |
| `@taizan/response` | `{code,message,data}` 契约、错误码常量、`BizError` 基类；四端共用的"剥响应包"协议 | knowledge `packages/shared/src/{response,error-codes}.ts` | ✅ | 200 |
| `@taizan/provision` | 租户开通事务编排（泛型 tx 接口，不 import Prisma 类型） | xiaodian `libs/common/src/tenant/provision.ts` 147 行 | ✅ | 200 |
| `@taizan/nest-core` | 全局异常 filter、响应拦截器（`@RawResponse()` 逃生口）、env zod 校验 + `assertNoDevCodeInProd`、AsyncLocalStorage 上下文中间件、pino + traceId 注入、健康检查 | filter/拦截器取 knowledge；env 校验取 xiaodian `libs/config/src/env.schema.ts`(114)；上下文取 xiaodian `libs/context`(32)；健康检查新写 | ❌ peer: `@nestjs/* ^10\|\|^11` | 900 |
| `@taizan/nest-prisma` | `$extends` 执行层（调用 `@taizan/tenant-scope` 的决策）、软删 extension（读+写）、`RawPrismaService` 逃生口 | 执行层取 knowledge `prisma.service.ts`(99)；软删 extension 取 xiaodian | ❌ peer: `@prisma/client ^5\|\|^6` | 400 |
| `@taizan/nest-auth` | 三套 JWT + 全局 APP_GUARD + `@Public()`、Redis 多会话按 jti 吊销、每请求现查成员关系（30s 缓存）、refresh token、`PermissionsGuard`（新写四级 RBAC） | 骨架 xiaodian `libs/auth/`；现查成员取 knowledge `staff-account.service.ts:225`；refresh + RBAC 新写 | ❌ peer nest | 1200 |
| `@taizan/nest-infra` | 队列（BullMQ）、分布式锁、分布式 cron、幂等键、缓存（强制租户前缀 key）、审计拦截器 | **全部新写**；`takeOnce` 取 knowledge `infra/redis.service.ts`；审计表与动作常量取 xiaodian `libs/audit/`(327) | ❌ peer nest | 1400 |
| `@taizan/web-core` | axios 拦截器剥包 + 401 清态、session store（我是谁/在哪家店）、菜单即数据、多租户登录与切换、权限路由组件、通用列表页 hook | `http.ts`/`session.ts`/`apps.tsx`/`ShopSwitcher` 取 knowledge；多品牌选择流程取 xiaodian `BrandChooserPage`；权限路由与列表 hook 新写 | ✅（仅依赖 axios/react） | 900 |
| `@taizan/app-ui` | RN 双端 token/组件/图表/`createApiClient`/SecureStore | knowledge `packages/app-ui/` 1216 行，近乎直接搬 | ✅ | 1200 |

模板仓库（不发包）：`create-taizan-app` —— 含 Nest api 骨架、平台侧 10 张表 schema + 模块、admin 后台、`apps/site` 官网（取 knowledge 11 页）、Taro client、Expo app、PM2/Nginx/部署脚本、CI 配置、三类测试各一个样例。

### 3.3 必须先统一的约定

| 项 | 推荐值 | 理由 |
|---|---|---|
| 主键 | **ULID 字符串**（新项目），老项目不动 | 对外不可枚举、时间有序索引局部性优于 cuid/UUIDv4；xiaodian 的 Int 自增会把租户数据量泄漏给外部。此条沿用历史文档，复核后无异议 |
| 表列命名 | snake_case + `@map`，代码侧 camelCase | DBA/BI 友好；xiaodian 已这么做，knowledge 是 camelCase 直用——统一到前者，代价只在新项目 |
| enum | **一律用 Prisma enum**，禁止裸 Int/String 状态 | knowledge 52 个 enum vs xiaodian 0 个。裸值的语义只存在于写代码那个人脑子里，且跨项目对不上 |
| 金额 | **一律 Int 分，字段名 `*Cents`，禁用 Decimal** | xiaodian 混用 61 处 cents + 28 处 Decimal，对账口径迟早打架 |
| Nest / Prisma | 新项目 Nest 11 + Prisma 6；基座包 peer 声明 `^10 \|\| ^11` / `^5 \|\| ^6` | 不强制老项目升级，但基座必须双版本 CI，否则第一次升级就分叉 |
| 测试框架 | **vitest** | knowledge 已用（unplugin-swc 解决 `emitDecoratorMetadata`），且基座包大量是零依赖纯函数，vitest 起得快。xiaodian 的 90 个 e2e 保留 jest 不动 |
| 代码风格 | **无分号 + 单引号**（xiaodian 风格），prettier 配置随基座包发布 | 必须挑死一个，选覆盖代码量更大的一边；knowledge 的 prettier 装了无配置文件等于没生效，改动成本低 |
| 响应包 | `{ code, message, data }` | `msg`/`message` 打架导致前端无法共用；`message` 更通用 |
| 错误码 | `{域段2位}{HTTP3位}{序号2位}` 7 位 | 合并两边优点：域段在模块多时好用（xiaodian 9 个域），HTTP 段让前端一眼判断该不该弹登录（knowledge 的优点）。两边老码各自保留，基座只约束新项目 |
| 隔离失败策略 | **失败关闭**，无上下文抛 `TenantScopeError`，未识别操作抛错 | 见第 1 节，已核实 xiaodian upsert 完全不隔离 |
| 高风险开关 | 一律带总开关、默认关、配自检脚本 | knowledge `BILLING_ENFORCE` + `billing-check.sh` 的范式，让"代码就绪"与"业务启用"解耦 |

### 3.4 数据库层策略

**基座 schema 包含的平台侧表（10 张）**，全部只用 tenantId 作为对外契约，不引用任何业务表：

`Tenant`（状态机 TRIAL/ACTIVE/OVERDUE/SUSPENDED/DEREGISTERED + 保留期）、`Plan`（app_keys + 配额三态 + 价格）、`PlanOrder`（下单/支付/续期闭环）、`Quota`（用量计数，与 Plan 配额对照）、`StaffAccount`（phone 全局唯一）、`Staff`（成员关系，实现一号多店）、`Role`+`Permission`（四级 RBAC，替代 xiaodian 的 `PlatformRolePreset`）、`PlatformAdmin`（补 CRUD，xiaodian 当前只能手工插库）、`AuditLog`（取 xiaodian 动作常量）。

**业务表如何挂接**：业务表只需满足两条——① 有 `tenant_id` 列并建复合索引 `(tenant_id, id)`；② 在项目自己的 `TENANT_MODELS` 清单里登记。业务表**不建外键指向 Tenant**（将来平台侧要平移成独立控制面服务时，外键会挡住）。历史文档的 `PlatformGateway` 接口思路保留：业务代码调 `hasApp()` / `checkQuota()` / `getTenant()` 三个方法，背后先是本地查库。

**TENANT_MODELS 与 schema 的同步机制随基座交付**：这是本次最该产品化的一件事。基座导出 `@taizan/tenant-scope/verify`——读项目自己的 `schema.prisma` 做**双向**比对（带 `tenant_id` 却不在清单 = 红；清单里有但 schema 无此列 = 红），并带 knowledge 那条"正则失效防假通过"哨兵。模板里预置 3 行 spec 调它，CI 强制跑。xiaodian 2026-08 的 StoreTable/MandatoryRecommend 泄漏正是漏登记导致，这个函数就是那次事故的产品化。

---

## 4. 抽取路线图

### 阶段一（1-2 周）：反向输出隔离层，两个老项目立刻受益

- **目标**：消除 xiaodian 的失败开放与 upsert 空洞，同时产出基座第一个包。
- **做什么**：把 knowledge 的 `tenant-scope.ts` 225 行提炼成 `@taizan/tenant-scope`（纯决策函数 + `verify` 校验器），knowledge 先换过去（它的测试更实，问题先暴露），跑绿后 xiaodian 用它替换 43 行的 `tenant.extension.ts`。xiaodian 侧需要一次灰度：先加 `TENANT_SCOPE_STRICT=false` 只打 warn 不抛错，跑一周看 15 个 cron 和脚本会触发多少次无上下文调用，逐个改成显式 `RawPrismaService`，再翻开关。
- **产出物**：`@taizan/tenant-scope@0.1.0`（npm 公开）、两个项目各一个 PR、`verify` 校验 spec 各一个。
- **验收标准**：① 两边 `pnpm test` 全绿；② 在 xiaodian 跑 `deploy/tenant-isolation-check.sh`（照 knowledge 的形式新写）返回全绿；③ 故意在 schema 加一张带 `tenant_id` 的表不登记，`verify` spec 变红；④ 故意在 xiaodian 写一段无上下文的 `prisma.order.findMany()`，抛 `TenantScopeError`。

### 阶段二（2-3 周）：零依赖协议层四个包

- **目标**：把两边各写一遍的东西收成一份。
- **做什么**：`@taizan/wechatpay`（xiaodian 605 行协议文件 + knowledge 官方样例测试）、`@taizan/ratelimit`（knowledge 296 行，顺便给 xiaodian 的 merchant-api/admin-api 补上限流——当前后台登录可无限撞库）、`@taizan/sms`（xiaodian 抽象 + knowledge TC3 签名）、`@taizan/crypto`（xiaodian 轮换脚本 + 新增 keyId）。
- **产出物**：四个 npm 包 + 两个项目的替换 PR + 每个包的双版本 Node CI。
- **验收标准**：① 每个包能在裸 node 里跑单测（这是"该不该抽"的硬判据）；② 微信支付包保留官方文档样例逐字节比对那条断言；③ 两边都换过去且都绿——只在一边用的包叫搬家不叫共享包；④ xiaodian 的 merchant/admin 登录接口在 `ratelimit-spoof-check.sh` 下拦得住伪造 XFF。

### 阶段三（3-4 周）：Nest 适配层三个包 + 补齐 P0 基础设施

- **目标**：把"两边都无"的 P0 一次补齐，并验证双版本 peer 可行。
- **做什么**：`@taizan/nest-core`（env 校验取 xiaodian、filter/拦截器取 knowledge、traceId 接进 pino、健康检查探 DB/Redis）、`@taizan/nest-prisma`、`@taizan/nest-infra`（队列/分布式锁/分布式 cron/幂等/租户前缀缓存/审计拦截器，全新写）。优先级最高的是分布式锁——knowledge 线上 4 实例正在并发跑关单和分账。
- **产出物**：三个包 + knowledge 的 7 处 `setInterval` 全部改成带锁的 cron + knowledge 补上 `AuditLog`（它当前平台侧高危操作零留痕）。
- **验收标准**：① CI matrix 在 Nest 10+Prisma 5 与 Nest 11+Prisma 6 两组下都绿；② knowledge 起 2 个进程跑关单任务，日志里同一 tick 只有一次执行；③ 任意一条请求的 traceId 能在 pino 日志、队列 job 日志、cron 日志里串起来；④ knowledge 平台侧冻结租户后，`AuditLog` 里能查到操作人/时间/目标租户；⑤ `/health` 在 Redis 停掉时返回非 200。

### 阶段四（3-4 周）：平台侧模板仓库

- **目标**：产出 `create-taizan-app`，第三套系统可以从它起步。
- **做什么**：10 张平台表 schema（按 3.3 约定）、平台管理面（xiaodian 13 模块为主 + knowledge 的账号分组与额度页）、四级 RBAC 与收费闭环（新写）、admin 后台（knowledge 骨架 + 新写权限路由）、`apps/site` 官网（knowledge 11 页直接搬）、Taro client、Expo app、PM2/Nginx 部署脚本（xiaodian）+ 线上自检脚本（knowledge 范式）+ CI。
- **产出物**：模板仓库 + `create-taizan-app` CLI + `.env.example` 完整字段清单 + CLAUDE.md（含"禁止绕过 tenantId"红线）。
- **验收标准**：`npx create-taizan-app demo && pnpm i && pnpm dev` 后**不写一行业务代码**走通：平台后台登录 → 建租户 → 商家后台登录 → 切换门店 → 示例 CRUD 增删改查 → 租户 A 的 token 访问租户 B 数据被拒 → 套餐到期后后台只读但续费入口仍可写。最后一条同时验证隔离、RBAC 和闸门。

### 阶段五（持续）：治理与反哺

- **目标**：让基座不分叉。
- **做什么**：严格 semver（签名逻辑任何行为变化都是 major，哪怕只改一行）；下游锁版本不用 `^`；两个老项目的改进走"提 PR 到基座 → 业务项目升版本"双向流程；每个包发布带变更影响面说明。
- **验收标准**：连续两个季度，两个老项目使用的基座包版本差距不超过一个 minor。

---

## 5. 需要负责人拍板的决策点

| 决策 | 选项 | 推荐 | 理由 |
|---|---|---|---|
| 是否现在就做基座 | A 按历史文档"等第三个项目再抽" / B 现在做 | **B，但只做已收敛的部分** | 历史文档的顾虑是"2 个样本互相矛盾"。现在矛盾已收敛到只剩主键一条，而那一条恰好是"不共享 schema"的理由。且 knowledge 的分布式 cron 是活故障，等不起 |
| 平台侧形态 | A 共享 npm 包 + schema 片段 / B 独立控制面服务 / C 模板 copy-in | **C** | A 的痛点（schema 变更同步三个项目）在主键不统一时无解；B 对当前规模过重且控制面挂了三套全挂。C 明确接受分叉，换取零同步成本，且边界仍切成将来可平移到 B 的形状（`PlatformGateway` 三方法） |
| 新项目主键 | A ULID / B 继续 cuid / C Int 自增 | **A** | 沿用历史文档。但需要你确认：ULID 会让新项目与两个老项目的 id 类型都不同，跨系统对账（同一商家买两套产品）时需要额外映射表 |
| 两个老项目是否回迁 | A 全量回迁 / B 只回迁阶段一二的包 / C 完全不动 | **B** | 阶段一二的包零框架依赖、可灰度、收益明确（补隔离洞、补限流、去重支付签名）。阶段三的 Nest 适配层回迁要动 Guard 和 Module 装配，风险大于收益，除非老项目本来就要升级 |
| xiaodian 是否升 Nest 11 / Prisma 6 | A 现在升 / B 跟随基座阶段三 / C 不升 | **B** | 现在升要改 94 个迁移的兼容和 extension API，纯成本。跟随阶段三升，可以借基座包的双版本 CI 当回归网 |
| 前端后台框架 | A 取 xiaodian(ProComponents 更成熟) / B 取 knowledge / C 新写 | **B 骨架 + C 权限层** | 这是我最不确定的一条。xiaodian 的 ProComponents + 145 个已跑通的页面是真实资产，但菜单硬编码、零路由守卫、`hasPerm()` 零调用意味着它的"框架"部分其实是空的。建议你亲自看一眼 `MainLayout.tsx` 的 `menuData` 再定 |
| 错误码方案 | A 取 xiaodian 6 位域段 / B 取 knowledge 5 位 HTTP 语义 / C 新混合方案 | **C** | 两套编号哲学不同不可能统一（历史文档已判定），老项目各自保留。但新项目必须挑死一个，混合方案能同时满足"模块多时好分域"和"前端一眼判断该不该弹登录" |
| 队列选型 | A BullMQ / B 直接用 Redis Stream / C 不做队列，用带锁的轮询 | **A** | 两边都已重度依赖 Redis，BullMQ 生态成熟、有死信和重试。C 是当前 knowledge 的做法，已证明不够 |
| 包托管 | A 公开 npm / B 私有 registry | **A** | 沿用历史文档：协议层无商业秘密，而两个项目都是宝塔服务器上跑 `pnpm install`，私有包意味着服务器配凭据+凭据轮换+忘了轮换就部署失败。但 Layer 2 的 Nest 包含有一些业务约定，需要你确认是否接受公开 |

---

## 6. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **分叉风险（最大）** | 平台侧走模板 copy-in，明确接受分叉。半年后三个项目的租户表可能长得完全不一样，"统一运营后台"这个目标就永远做不成了 | ① 把 10 张平台表的**列名与语义**写成一份 `PLATFORM-SCHEMA.md` 契约文档，允许各项目加列但禁止改已有列语义；② 基座提供 `verify-platform-schema` 校验器，各项目 CI 跑；③ 每季度对一次差异，超阈值就讨论是否该收成控制面（方案 B） |
| **老项目回迁成本被低估** | xiaodian 阶段一要把 15 个 cron + 11 个 seed 脚本 + 各类后台任务全部审一遍是否有租户上下文。这个工作量可能远大于换包本身 | 分两步：先 `TENANT_SCOPE_STRICT=false` 只打 warn 跑一周收集真实调用点清单，再逐个改，最后才翻开关。不要一次性硬切 |
| **Prisma 5→6 升级风险** | xiaodian 94 个迁移 + 103 model，extension API 在 5→6 有变化，当前 upsert 空洞的直接成因是扩展只改 `args.data`，与版本无关，但升级时必须一并补齐 | 基座包用 peer `^5 \|\| ^6` 并跑双版本 CI matrix；xiaodian 升级单独排期，先在 dev compose 上用 `prisma migrate diff` 做 dry-run；knowledge 侧的 `migrate deploy` 线上跑不通这个问题必须先解决（当前靠手写幂等 SQL） |
| **Nest 10→11 装饰器/中间件签名差异** | 基座的 Guard 和拦截器要同时兼容两版 | Layer 2 包的公开 API 只用 Nest 稳定接口（`CanActivate`/`NestInterceptor`/`ExceptionFilter`），不碰内部 API；每个 Layer 2 包配一个最小 Nest app 的集成测试，双版本各跑一遍 |
| **基座变成第三个要维护的项目** | 团队规模有限，基座包一多，改一次要同步三个下游，历史文档担心的"变成化石"就发生了 | ① 严格控制包数量，本报告 16 个包里 Layer 0-1 的 10 个是零依赖低维护，真正有维护成本的只有 3 个 Nest 包；② 严格 semver + 下游锁版本，让升级是显式动作；③ 阶段五的"两个季度内版本差不超过一个 minor"是硬指标，超了说明基座没人用，该停 |
| **`@taizan/nest-infra` 全是新写代码** | 队列/锁/幂等/缓存四块没有任何一边的生产验证，等于在基座里塞了一坨未经检验的代码 | 先在 knowledge 落地（它有活故障，收益最直接、反馈最快），跑满一个月无事故再抽成包。**不要先写包再找地方用** |
| **公开 npm 泄漏业务信息** | `@taizan/billing-rules` 里含套餐闸门规则、`@taizan/nest-auth` 含权限模型 | 计费规则包只放**判定算法**不放具体档位与价格（那些是数据，留在各项目 DB）；如果仍不放心，Layer 2 的三个 Nest 包改走 GitHub Packages，接受服务器配凭据的成本——但 Layer 0-1 的 10 个包必须公开，否则部署会因凭据问题失败 |
| **阶段四验收标准过高导致延期** | "不写一行业务代码走通 8 个场景"是个很硬的标准 | 这条不建议放宽——它正是参考清单里"一键初始化流程"的验收点。如果做不到，说明基座还不能给第三个项目用，宁可延期也不要交一个半成品模板 |
