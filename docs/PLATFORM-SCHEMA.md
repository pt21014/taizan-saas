# 平台基础表契约（`@taizan/prisma-base`）

框架提供 **27 张表 / 24 个枚举**，分在 9 个 `.prisma` 片段里。业务项目通过
`pnpm taizan:schema-sync` 把它们拷进 `apps/api/prisma/schema/00-base/`，
**只读，不许手改**。

**表结构是这个框架最难改的东西**：业务项目一旦跑过 `migrate`，改一列就得写迁移脚本，
而且是在别人的生产库上跑。所以这里的每条约定都有对应的静态断言
（`packages/prisma-base/src/schema.spec.ts`），改坏了 CI 立刻红。

本文回答四个问题：**有哪些表**、**哪些字段不许动**、**能加什么**、**升级时怎么迁**。

---

## 1. 数据约定（蓝图 §3.1，不可协商）

| 项 | 定成 | 违反谁会红 |
| --- | --- | --- |
| 主键 | `String @id @db.VarChar(26)`，值是**应用层生成的 ULID**（`@taizan/contracts` 的 `ulid()`，`@taizan/nest-prisma` 在 create 时自动填充）。schema 里**没有** `@default(cuid())` | `packages/prisma-base/src/schema.spec.ts` |
| 字段名 | camelCase 直用，不做 `@map` / `@@map` | 同上 |
| 状态 | 一律 Prisma `enum`，禁止裸 `Int` / `String` | 同上 |
| 金额 | 一律 `Int`，字段名以 `Cents` 结尾，**禁用 `Decimal`** | 同上 |
| 时间 | `createdAt @default(now())` + `updatedAt @updatedAt` 每张表都有；软删用 `deletedAt DateTime?` | 同上 |
| 租户列 | `tenantId String` **一律 NOT NULL**。需要「平台共享 + 租户私有」的**拆成两张表**（`RolePreset` / `Role`） | `packages/tenant-scope/src/verify.spec.ts` |
| 索引 | 每张租户表必须有 `@@index([tenantId, id])`；软删表的唯一索引必须带 `deletedAt` | `packages/prisma-base/src/schema.spec.ts` |
| 外键 | **一条 relation 都不建**（含不建指向 `Tenant` 的外键） | 同上（`allowRelations` 默认放行业务片段，框架片段为零） |

为什么禁可空 `tenantId`：xiaodian 的 `MaterialFolder` 因为 `tenantId` 可空被移出隔离名单，
从此那张表就是个例外——而**例外是最容易在下一次重构里被忘掉的东西**。拆表多了 3 张表，
换来隔离名单零例外。

为什么不建外键：将来平台侧（`Tenant` / `Plan` / `PlatformAdmin` 这些平台域表）要能平移成
独立的控制面服务，跨库外键会直接挡路。

---

## 2. 27 张表

「域」列决定了这张表**走不走租户隔离**：

- **租户域（10 张）** —— 在 `BASE_TENANT_MODELS` 里，业务代码用 `prisma.tenant.xxx` 访问，`tenantId` 由扩展自动注入；
- **平台域（17 张）** —— 不在隔离名单里，只能用 `RawPrismaService` 访问，且要在 `raw-reasons.ts` 登记理由。

> 平台域表里那些「需要记录来源租户」的列，名字一律叫 `originTenantId` / `targetTenantId`，
> **不叫 `tenantId`**。这是刻意的：那不是归属列，不该被隔离校验器当成归属列，
> 也不该让人误以为这张表受隔离保护。框架的隔离白名单因此**是空的**——这是设计目标，不是巧合。

### 01-tenant.prisma

| 表 | 域 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `Tenant` | 平台 | 租户主体 | `slug`（全局唯一、**不可改**）、`status TenantStatus`、`planId?`、`planExpireAt?`、`trialEndAt?`、`graceDays Int @default(0)`、`retentionDays Int @default(7)`、`deregisterAt?`、`ownerAccountId` |
| `TenantVerification` | 租户 | 实名/资质提交与审核，可多次提交保留历史 | `type VerifyType`、`legalName`、`licenseNo`、`attachments Json`、`status VerifyStatus`、`reviewedBy?`、`rejectReason?` |
| `TenantCredential` | 租户 | 租户级三方密钥统一入口 | `provider` + `credKey`、`valueEnc @db.Text`、`keyId`、`maskedHint?`、`deletedAt?`；`@@unique([tenantId, provider, credKey, deletedAt])` |

枚举：`TenantStatus{TRIAL,ACTIVE,SUSPENDED,DEREGISTERED}`（**刻意没有 `EXPIRED`**——到期永远现算）、
`VerifyType{ENTERPRISE,INDIVIDUAL,PERSONAL}`、`VerifyStatus{PENDING,APPROVED,REJECTED}`。

### 02-plan.prisma

| 表 | 域 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `Plan` | 平台 | 套餐定义 | `code`（唯一）、`firstPriceCents` / `renewPriceCents`、`periodMonths`、`quotas Json`（**三态**）、`features Json?`（`null`=全部可用）、`appKeys Json`、`trafficMb`、`status PlanStatus`、`sort` |
| `PlanOrder` | 租户 | 平台收费订单 | `type PlanOrderType`、`periods`、`amountCents` / `discountCents`、`status PlanOrderStatus`、`payChannel PayChannel?`、`outTradeNo`（**全局唯一**）、`transactionId?`、`paidAt?` / `fulfilledAt?`、`expireBeforeAt?` / `expireAfterAt?`、`operatorId?` |
| `QuotaCounter` | 租户 | 配额物化计数 | `kind QuotaKind`、`used`、`version`（乐观锁）；`@@unique([tenantId, kind])` |

枚举：`PlanStatus{ENABLED,DISABLED,ARCHIVED}`、`PlanOrderType{OPEN,RENEW,UPGRADE}`、
`PlanOrderStatus{PENDING,PAID,FULFILLED,CANCELLED,REFUNDED}`、`PayChannel{WECHAT,ALIPAY,DOUYIN,OFFLINE}`、
`QuotaKind{STAFF,STORE,MEMBER,STORAGE_MB,TRAFFIC_MB,CUSTOM}`。

三处设计要点：

- **`outTradeNo` 全局唯一而不是租户内唯一**：支付回调进来时**还没有租户上下文**，只能靠它定位。
- **`expireBeforeAt` / `expireAfterAt` 两列都存**：退款要回退到期日，没有「之前是多少」就只能猜。
- **`QuotaCounter` 是物化计数**：闸门挂在每个请求上，不可能每次 `COUNT(*)`。代价是要在
  业务侧成对调用 `consume` / `release`（见 `docs/EXTENSION-POINTS.md` §1 附）。

### 03-identity.prisma

| 表 | 域 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `PlatformAdmin` | 平台 | 平台管理员 | `username`（唯一）、`passwordHash`、`status AccountStatus`、`roleIds Json`、`mfaSecretEnc?` + `mfaKeyId?`、`lastLoginAt?` |
| `StaffAccount` | 平台 | 商家登录账号，**一号多店的载体** | `phone`（**全局唯一**）、`passwordHash`、`name`、`avatar?`、`status` |
| `Staff` | 租户 | 账号 × 租户的成员关系 | `accountId`、`status StaffStatus`、`roleIds Json`、`dataScope DataScope`、`scopeTargets Json?`、`isOwner`、`invitedBy?`、`joinedAt`、`deletedAt?`；`@@unique([tenantId, accountId, deletedAt])` |
| `StaffInvite` | 租户 | 员工邀请码，一次性核销 | `phone?`、`token`（唯一）、`roleIds Json`、`expiresAt`、`usedAt?` / `usedBy?` |
| `Member` | 租户 | C 端会员 | `phone?` / `unionId?` / `openId?`、`nickname?`、`status MemberStatus`、`lastLoginAt?`、`deletedAt?`；三条 `@@unique([tenantId, X, deletedAt])` |

枚举：`AccountStatus{ACTIVE,DISABLED}`、`StaffStatus{ACTIVE,DISABLED,LEFT}`、
`MemberStatus{ACTIVE,DISABLED}`、`DataScope{ALL,SUB_TREE,SELF,CUSTOM}`。

**`StaffAccount`（平台域）与 `Staff`（租户域）分开**是「一个手机号开多家店」的全部实现：
登录时跨租户找 `StaffAccount`，选店之后签一张只绑那家店的 token，
而每个请求都用 `Staff` 现查一次成员关系（详见 `docs/SECURITY-INVARIANTS.md` K5）。

### 04-rbac.prisma

| 表 | 域 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `Permission` | 平台 | 权限点**镜像** | `code`（唯一）、`module`、`name`、`type PermType`、`sort` |
| `Menu` | 平台 | 菜单**镜像** | `key`（唯一）、`parentKey?`、`title`、`icon?`、`path?`、`componentKey?`、`type MenuType`、`permission?`、`featureKey?`、`side MenuSide` |
| `RolePreset` | 平台 | 平台下发的角色模板 | `code` + `side`（复合唯一）、`permissionCodes Json`、`builtin` |
| `Role` | 租户 | 租户自己的角色 | `code`、`permissionCodes Json`、`menuKeys Json?`、`builtin`、`deletedAt?`；`@@unique([tenantId, code, deletedAt])` |

枚举：`PermType{API,MENU,BUTTON}`、`MenuType{DIR,MENU,BUTTON}`、`MenuSide{ADMIN,PLATFORM}`。

**`Permission` 与 `Menu` 是镜像，不是真源**。真源是代码里的注册表
（`apps/api/src/registry/permissions.ts` / `menus.ts`），DB 里这两张表只是给「角色编辑页勾选」
和「按 module 分组展示」用的查询面，由 `pnpm -F @taizan/api seed` 或 RBAC 同步命令刷进去。
直接改 DB 里的行，下次同步会被覆盖——而且 `apps/api/test/arch/permission-registry.spec.ts`
根本不看 DB。

### 05-audit.prisma

| 表 | 域 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `AuditLog` | 租户 | 租户内操作审计 | `actorType ActorType`、`actorId` / `actorName`、`action`、`targetType?` / `targetId?`、`before Json?` / `after Json?`、`ip`、`traceId`、`result AuditResult` |
| `PlatformAuditLog` | 平台 | 平台高危操作审计 | 同上，但用 `targetTenantId?` 替代 `tenantId`，`actorType @default(PLATFORM_ADMIN)` |

枚举：`ActorType{PLATFORM_ADMIN,STAFF,MEMBER,SYSTEM}`、`AuditResult{SUCCESS,FAIL}`。

拆两张表而不是一张带可空 `tenantId` 的表——同 §1 的理由。

### 06-ops.prisma

| 表 | 域 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `Announcement` | 平台 | 平台公告 | `contentHtml @db.LongText`、`audience Audience`、`audienceRefs Json?`、`level`、`publishAt` / `expireAt?`、`status` |
| `AnnouncementRead` | 平台 | 已读回执（跨租户统计） | `@@unique([announcementId, readerType, readerId])` |
| `PlatformSetting` | 平台 | site-config / 开关 / 平台密钥 | `key`（唯一）、`value Json`、`valueEnc?` + `keyId?` |

枚举：`Audience{ALL_TENANT,PLAN,TENANT_IDS,C_END}`、`AnnouncementLevel{INFO,WARNING,CRITICAL}`、
`AnnouncementStatus{DRAFT,PUBLISHED,ARCHIVED}`。

### 07-infra.prisma

| 表 | 域 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `IdempotencyKey` | 平台 | 幂等键 | `scope` + `key`（复合唯一）、`status IdempotencyStatus`、`resultHash?`、`expiresAt` |
| `JobDeadLetter` | 平台 | 队列死信，平台后台可重放 | `queue` / `jobName`、**`originTenantId?`**、`payload Json`、`attempts`、`lastError`、`traceId`、`resolvedAt?` |
| `CronRun` | 平台 | leader cron 的可观测面 | `key`、`startedAt` / `finishedAt?`、`instanceId`、`ok`、`error?` |
| `OutboxEvent` | 平台 | 事务发件箱（事务内写、队列外发） | **`originTenantId?`**、`topic`、`payload Json`、`status OutboxStatus`、`attempts`、`availableAt` |

枚举：`IdempotencyStatus{IN_PROGRESS,SUCCEEDED,FAILED}`、`OutboxStatus{PENDING,SENT,FAILED,DEAD}`。

### 08-notify.prisma

| 表 | 域 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `NotifyTemplate` | 平台 | 通知模板 | `key`（唯一）、`channel NotifyChannelKind`、`title` / `content`、`providerTemplateId?`、`enabled` |
| `NotifyRecord` | 租户 | 租户通知发送记录 | `channel`、`templateKey`、`to`、`vars Json`、`status NotifyStatus`、`error?`、`traceId`、`sentAt?` |
| `PlatformNotifyRecord` | 平台 | 平台通知发送记录 | 同上，用 `targetTenantId?` |

枚举：`NotifyChannelKind{SMS,EMAIL,WECHAT_OA,WECHAT_MP,APP_PUSH,IN_APP}`、
`NotifyStatus{PENDING,SENDING,SENT,FAILED}`。

> ⚠️ **DB 枚举与 TS 枚举不同名**。`@taizan/nest-notify` 的 TS 侧是
> `SMS | INBOX | MP_TEMPLATE | APP_PUSH`（蓝图 §4.13），DB 侧是上面 6 个值，
> 只有 `SMS` / `APP_PUSH` 凑巧同名。转换收口在 `packages/nest-notify/src/channel-map.ts`
> 的 `toDbNotifyChannel` / `fromDbNotifyChannel`，**读写两条路径都要转**。
> 这不是笔误——它是 T1-5 一条真实 bug 的根治面：直接把 TS 值塞进 DB 列时
> `INBOX` / `MP_TEMPLATE` 在 DB 枚举里根本不存在，Prisma 抛错、调用方 try/catch 吞掉，
> 表现是「发送成功了」但一行记录都没落库。**业务侧不要绕过这两个函数直接写 `channel` 列。**

### 租户域 10 张（`BASE_TENANT_MODELS`）

`TenantVerification`、`TenantCredential`、`PlanOrder`、`QuotaCounter`、
`Staff`、`StaffInvite`、`Member`、`Role`、`AuditLog`、`NotifyRecord`。

清单在 `packages/prisma-base/src/tenant-models.ts`，与 schema 双向比对
（`packages/prisma-base/src/tenant-models.spec.ts`）。

---

## 3. 业务项目**不许**改的东西

`00-base/**` 整个目录都是框架托管的，改任何一个字节
`apps/api/test/arch/base-schema-integrity.spec.ts` 都会红（sha256 比对 `base.lock.json`）。
但「为什么某些列尤其不能动」值得单独写清楚——下面这些是**即使框架允许你改，改了也会出事**的：

| 不许改 | 改了会怎样 |
| --- | --- |
| `Tenant.slug` 的全局唯一 | C 端靠 slug 选店（`X-Tenant-Slug` / 子域名）。允许重复 = 两家店抢同一个入口 |
| `Tenant.status` 加回 `EXPIRED` | 「到期落状态」需要 cron 去改状态，cron 漏跑一批租户就卡在错误状态。框架的选择是**永远现算** |
| `PlanOrder.outTradeNo` 的**全局**唯一 | 改成租户内唯一，支付回调（此刻还没有租户上下文）就没法定位订单 |
| 任何 `*Enc` 列少了配对的 `keyId` 列 | 密钥轮换到一半分不清新旧，只能全量停机换。`packages/crypto/src/columns.spec.ts` 三处对账拦着 |
| 租户表的 `tenantId` 改成可空 | 那张表变成隔离名单的「例外」，例外一定会被忘掉。`packages/tenant-scope/src/verify.spec.ts` 直接判红 |
| 租户表去掉 `@@index([tenantId, id])` | 隔离扩展给每个 where 都加 `tenantId`，没索引 = 每次全表扫 |
| 把 `PlatformAuditLog` / `PlatformNotifyRecord` 合并回带可空 `tenantId` 的单表 | 同上，隔离名单出现例外 |
| 给 `JobDeadLetter` / `OutboxEvent` 的 `originTenantId` 改名叫 `tenantId` | 隔离校验器会把这张平台域表当成租户表，然后要么强制你登记（登记了运行时就炸），要么你去写白名单——白名单一开就再也关不上 |
| 金额列改 `Decimal` 或去掉 `Cents` 后缀 | 对账口径打架。`packages/prisma-base/src/schema.spec.ts` 拦着 |
| 加任何一条 relation / 外键 | 平台侧将来平移成独立服务时会挡路 |

---

## 4. 允许追加什么

### 4.1 加你自己的表 — 一律放 `10-business/`

```
apps/api/prisma/schema/
├─ 00-base/            ← 框架托管，只读
│  ├─ 00-datasource.prisma      （generator + datasource，全仓唯一一处）
│  └─ 01..08-*.prisma
├─ 10-business/        ← 你的地盘
│  └─ 10-goods.prisma
└─ base.lock.json      ← 每个片段的 sha256 + 框架版本
```

规则与框架片段完全一样（§1 那张表）。`datasource` 只在 `00-base/00-datasource.prisma` 里出现一次，
业务片段里不要再写。加表的完整流程见 `docs/EXTENSION-POINTS.md` §1。

### 4.2 给框架表加列？—— 不行，但有三条替代路径

Prisma 的多文件 schema **不支持** `extend model`，所以你没法在 `10-business/` 里给 `Tenant` 加一列。
框架也不希望你这么做（加了之后 `schema-sync` 每次都冲突）。三条替代：

| 你想要的 | 该怎么做 |
| --- | --- |
| 给租户挂业务属性（行业、门店坐标、自定义配置） | 建一张 `TenantProfile { id, tenantId, ... }`，`@@unique([tenantId])`，走租户域。**这也是更好的建模**：框架表变了不影响你 |
| 给套餐挂业务字段 | `Plan.appKeys Json` 与 `Plan.quotas Json` 就是留给这个的；再不够就建 `PlanExtra` |
| 给三方密钥加一种 provider | 不用改表：`TenantCredential` 的 `provider` + `credKey` 是自由字符串，加一行数据即可 |

真的必须改框架表（例如需要一列建索引、Json 顶不住）：**提到框架仓库改**，
走一次 `@taizan/prisma-base` 的 major 发版（`docs/RELEASE.md` §2）。
本地手改的下场是下次 `schema-sync` 要么覆盖你的改动，要么在 CI 上一直红。

### 4.3 加加密列

密文列必须**同时**做三件事，缺一件轮换时就漏：

1. schema 里加 `xxxEnc String @db.Text` **和配对的 keyId 列**；
2. 登记进注册表（框架的在 `packages/prisma-base/src/encrypted-columns.ts`，项目侧同形状一份）：
   ```ts
   { model: 'TenantCredential', column: 'valueEnc', keyIdColumn: 'keyId',
     description: '租户级三方密钥的密文，接口只回 maskedHint。' }
   ```
3. 三处对账自动生效：`packages/prisma-base/src/schema.spec.ts`（注册表 ↔ schema）+
   `packages/crypto/src/columns.spec.ts`（+ 轮换脚本覆盖列）。

框架当前三条加密列：`TenantCredential.valueEnc` / `PlatformSetting.valueEnc` /
`PlatformAdmin.mfaSecretEnc`。**明文永远不落库，接口只回 `maskedHint`。**

---

## 5. `schema-sync` + `base.lock.json` 机制

Prisma 6 支持 `schema` 指向目录，但 **Prisma 不能从 `node_modules` include 片段**。
所以框架用的是「同步 + 校验」而不是「引用」。

```jsonc
// apps/api/package.json（生成器已经写好）
{
  "scripts": {
    "taizan:schema-sync":  "taizan-schema-sync prisma/schema",
    "taizan:schema-check": "taizan-schema-sync prisma/schema --check",
    "prisma:migrate":      "pnpm run taizan:schema-sync && prisma migrate dev"
  }
}
```

- **`taizan:schema-sync`** 从 `@taizan/prisma-base` 拷贝 `00-base/`，并写入 `base.lock.json`
  （每个文件的 sha256 + 包版本）。每个被托管的文件头都带「框架托管，勿改」横幅。
- **`--check`**（CI 与 `apps/api/test/arch/base-schema-integrity.spec.ts` 跑的那条）比对现有
  `00-base/` 与 lock：片段被手改、lock 里的版本对不上、少片段/多片段，一律**非零退出并列出差异文件**。
  比对时会把 CRLF 归一成 LF 再算 sha256，Windows 检出不会误报。
- **`prisma:migrate` 前置依赖 `schema-sync`**：这条依赖是为了消灭「装了新版包但 schema 没更新」
  这个状态——它的表现是 migrate 生成了一份不含新字段的迁移，然后运行时报「列不存在」。
- **迁移历史不放在 `00-base/` 旁边**：多文件 schema 下 Prisma 默认把 migrations 放在
  「含 datasource 的那个片段」旁边，也就是框架托管目录。`apps/api/prisma.config.ts` 用
  `migrations.path` 把它挪了出来。

另一条独立的校验命令：

```bash
pnpm -F @taizan/api taizan:verify-schema   # 隔离名单 ↔ schema 双向比对
```

它自动补上框架的 10 张租户表，你只报自己的（`--registered=Goods,GoodsSku`）。
带 `tenantId` 却没登记 → 红；登记了但 schema 里查无此列 → 红；`tenantId` 可空 → 红。
带「正则失效防假通过」哨兵。

---

## 6. 框架 schema 升级时的迁移流程

完整的版本升级流程见 `docs/UPGRADE.md`。这里只讲 schema 那一段：

```bash
# 1) 升版本，读 CHANGELOG 的「变更影响面」三栏，确认 schema 栏写了什么
pnpm update @taizan/prisma-base --latest

# 2) 重新同步框架片段（会同时刷新 base.lock.json）
pnpm -F @taizan/api taizan:schema-sync

# 3) 人眼 review —— 这一步不能跳
git diff apps/api/prisma/schema/00-base

# 4) 生成并跑迁移（本地）
pnpm -F @taizan/api prisma:migrate
git diff apps/api/prisma/migrations         # 看生成的 SQL

# 5) 回归
pnpm -F @taizan/api test                    # 含全部 arch spec
pnpm -F @taizan/api test:e2e                # 连真库的隔离 e2e
```

第 3 步为什么不能跳：`schema-sync` 只负责把框架片段拼进来，
**它不判断「这个改动我们能不能接受」**。要重点看的三类：

| 看什么 | 因为 |
| --- | --- |
| 新增的**非空无默认值**列 | 已有数据的表加这种列，`migrate` 生成的 SQL 在生产会直接失败。需要拆成「加可空列 → 回填 → 改非空」三步 |
| 变窄的类型 / 删列 | 数据会丢。CHANGELOG 里这类必然是 major，且必须附数据迁移脚本 |
| 新增/变更的唯一索引 | 已有数据里若有重复行，`migrate deploy` 在生产会失败——而这时你已经停机了。**先在生产的只读副本上跑一次 `SELECT ... GROUP BY ... HAVING COUNT(*) > 1`** |

生产环境走 `prisma migrate deploy`（`deploy/scripts/migrate.sh`），**不是 `migrate dev`**：
后者会在检测到 drift 时提议重置数据库。

---

## 7. 已知取舍

- **MySQL 把唯一索引里的 NULL 视为互不相同**，所以 `@@unique([tenantId, phone, deletedAt])`
  在 `deletedAt IS NULL` 时**挡不住两行活跃重复**。这是「唯一索引必须带 `deletedAt`」
  （为了软删后能重建同名记录）与 MySQL 语义的固有冲突，活跃行的唯一性要靠应用层兜。
  受影响：`Staff`、`Member`、`Role`、`TenantCredential`。
  **所有真正需要硬唯一的键都放在没有 `deletedAt` 的表上**：`Tenant.slug`、`StaffAccount.phone`、
  `PlatformAdmin.username`、`Plan.code`、`PlanOrder.outTradeNo`、`Permission.code`、`Menu.key`、
  `PlatformSetting.key`、`NotifyTemplate.key`、`IdempotencyKey(scope,key)` —— 这些是真约束。
- **`@taizan/prisma-base` 不生成 Prisma Client**，也不依赖它的运行时类型；`prisma` 是
  optional peerDependency，只有跑 `prisma validate` / `migrate` 的项目才需要装。
- **多文件 schema 在 Prisma 6 已 GA**，实测 6.19.3 直接 `--schema schema` 通过，不需要
  `previewFeatures`。同步到 Prisma 5.15–6.6 的项目才需要自行补该 preview flag。

---

## 8. seed

```ts
import { PrismaClient } from '@prisma/client'
import { seedBase } from '@taizan/prisma-base'

const prisma = new PrismaClient()   // 原始 client，不要套租户隔离扩展
await seedBase(prisma)
```

产出：平台管理员 `admin` / `admin123`；两档套餐（体验版 `STAFF=3`、`TRAFFIC_MB=0`；
标准版 `STAFF=null`、`features=null`）；内置角色模板；TRIAL 演示租户 `demo` +
店主 `13800000000` / `123456`。

三条纪律：全程 upsert（**重复跑不出事**）；**不重置已有账号的口令**、不刷新已有租户的试用期
（seed 不能是后门）；套餐价格与配额每次覆盖（seed 是它们的真源）。
生产初始化用 `seedBase(prisma, { withDemoTenant: false })`。

口令哈希格式 `scrypt$N$r$p$salt$hash`（base64），参数写在串里——以后调高成本参数时
老口令还能校验，登录成功时按 `needsRehash` 重算写回。

---

## 相关文档

- `packages/prisma-base/README.md` — 同一份内容的包内速查版 + CLI 参数细节
- `docs/EXTENSION-POINTS.md` — 加一张业务表要动的其他六处
- `docs/UPGRADE.md` — 完整的版本升级流程
- `docs/SECURITY-INVARIANTS.md` — 为什么隔离名单不能有例外
