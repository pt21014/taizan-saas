# @taizan/prisma-base

框架基础表。提供 9 个 Prisma schema 片段（27 张表 / 24 个 enum）、基础 `TENANT_MODELS`、
加密列注册表、`schema-sync` 与 `verify-schema` 两个 CLI，以及一份幂等 seed。

**表结构是这个框架最难改的东西**：业务项目一旦跑过 migrate，改列就得写迁移脚本。
所以这里的每一条约定都有对应的静态断言（`src/schema.spec.ts`），改坏了 CI 立刻红。

---

## 1. 表清单

| 片段 | 表 | 域 | 说明 |
| --- | --- | --- | --- |
| `00-datasource.prisma` | —— | —— | generator + datasource，全仓唯一一处 |
| `01-tenant.prisma` | `Tenant` | 平台域 | 租户主体；`slug` 全局唯一不可改；**刻意无 EXPIRED 状态**，到期现算 |
| | `TenantVerification` | 租户域 | 实名/资质提交与审核，可多次提交保留历史 |
| | `TenantCredential` | 租户域 | 租户级三方密钥统一入口（`valueEnc` + `keyId`） |
| `02-plan.prisma` | `Plan` | 平台域 | 套餐；`quotas` 三态、`features` null=全部 |
| | `PlanOrder` | 租户域 | 平台收费订单；`outTradeNo` 全局唯一（回调时还没有租户上下文） |
| | `QuotaCounter` | 租户域 | 配额物化计数 + 乐观锁 `version` |
| `03-identity.prisma` | `PlatformAdmin` | 平台域 | 平台管理员；`mfaSecretEnc` + `mfaKeyId` |
| | `StaffAccount` | 平台域 | 商家登录账号（一号多店的载体），手机号全局唯一 |
| | `Staff` | 租户域 | 账号 × 租户的成员关系 |
| | `StaffInvite` | 租户域 | 员工邀请码，一次性核销 |
| | `Member` | 租户域 | C 端会员 |
| `04-rbac.prisma` | `Permission` | 平台域 | 权限点镜像（真源在代码注册表） |
| | `Menu` | 平台域 | 菜单镜像（真源在代码注册表），`side` 区分 admin/platform |
| | `RolePreset` | 平台域 | 平台下发的角色模板 |
| | `Role` | 租户域 | 租户自己的角色 |
| `05-audit.prisma` | `AuditLog` | 租户域 | 租户内操作审计 |
| | `PlatformAuditLog` | 平台域 | 平台高危操作审计，用 `targetTenantId` |
| `06-ops.prisma` | `Announcement` | 平台域 | 平台公告 |
| | `AnnouncementRead` | 平台域 | 已读回执（跨租户统计） |
| | `PlatformSetting` | 平台域 | site-config / 开关 / 平台密钥（`valueEnc` + `keyId`） |
| `07-infra.prisma` | `IdempotencyKey` | 平台域 | 幂等键 |
| | `JobDeadLetter` | 平台域 | 队列死信，来源租户记在 `originTenantId` |
| | `CronRun` | 平台域 | leader cron 的可观测面 |
| | `OutboxEvent` | 平台域 | 事务发件箱，来源租户记在 `originTenantId` |
| `08-notify.prisma` | `NotifyTemplate` | 平台域 | 通知模板 |
| | `NotifyRecord` | 租户域 | 租户通知发送记录（`tenantId` 必填） |
| | `PlatformNotifyRecord` | 平台域 | 平台通知发送记录，用 `targetTenantId` |

**租户域 10 张**：`TenantVerification` `TenantCredential` `PlanOrder` `QuotaCounter`
`Staff` `StaffInvite` `Member` `Role` `AuditLog` `NotifyRecord`。
清单在 `src/tenant-models.ts` 的 `BASE_TENANT_MODELS`，与 schema 双向比对。

24 个 enum：`TenantStatus` `VerifyType` `VerifyStatus` `PlanStatus` `PlanOrderType`
`PlanOrderStatus` `PayChannel` `QuotaKind` `AccountStatus` `StaffStatus` `MemberStatus`
`DataScope` `PermType` `MenuType` `MenuSide` `ActorType` `AuditResult` `Audience`
`AnnouncementLevel` `AnnouncementStatus` `IdempotencyStatus` `OutboxStatus`
`NotifyChannelKind` `NotifyStatus`。

### 数据约定（蓝图 §3.1，不可协商）

- 主键 `String @id`，值是**应用层生成的 ULID**，schema 里没有 `@default(cuid())`；
  `id` 与 `tenantId` 都声明成 `@db.VarChar(26)`（ULID 定长）。
- 字段名 camelCase 直用，不做 `@map` / `@@map`。
- 状态一律 enum；金额一律 `Int` 且字段名以 `Cents` 结尾，**禁用 `Decimal`**。
- `createdAt @default(now())` + `updatedAt @updatedAt` 每张表都有；软删用 `deletedAt DateTime?`。
- 租户列 `tenantId String` **一律 NOT NULL**；需要「平台共享 + 租户私有」的一律拆表。
- 每张租户表都有 `@@index([tenantId, id])`；软删表的唯一索引都带 `deletedAt`。
- **一条 relation 都不建**（含不建指向 `Tenant` 的外键）：将来平台侧要能平移成独立控制面服务。

---

## 2. 在业务项目里 sync

Prisma 不能从 `node_modules` include 片段，所以是「同步 + 校验」而不是「引用」：

```
apps/api/prisma/schema/
├─ 00-base/           ← 本包同步过来，勿手改
│  ├─ 00-datasource.prisma
│  └─ 01..08-*.prisma
├─ 10-business/       ← 你自己的片段
│  └─ 10-goods.prisma
└─ base.lock.json     ← 每个片段的 sha256 + 框架版本
```

```jsonc
// apps/api/package.json
{
  "scripts": {
    "taizan:schema-sync": "taizan-schema-sync prisma/schema",
    "taizan:schema-check": "taizan-schema-sync prisma/schema --check",
    "prisma:migrate": "pnpm taizan:schema-sync && prisma migrate dev --schema prisma/schema"
  }
}
```

- 升级框架 = 升版本 → 重跑 `taizan:schema-sync` → review diff → 跑 migrate。
- CI 与 `base-schema-integrity.spec.ts`（蓝图 spec 15）跑 `--check`：片段被手改、
  lock 版本对不上、少片段多片段，一律非零退出并列出差异文件。
- `--check` 比对时会把 CRLF 归一成 LF 再算 sha256，Windows 检出不会误报。

> `datasource` 只在 `00-base/00-datasource.prisma` 里出现一次，业务片段里不要再写。
> 需要改数据库连接方式（换 provider、加 `directUrl`）请提 issue，不要本地手改。

---

## 3. 如何登记业务表

新加一张带 `tenantId` 的表却忘了登记 = **那张表完全没有租户隔离**，而且不报错。
所以登记与校验是一套：

```ts
// apps/api/src/tenancy/tenant-models.ts
import { createBaseRegistry } from '@taizan/prisma-base'

export const registry = createBaseRegistry()
registry.register(['Goods', 'GoodsSku'])
export const TENANT_MODELS = registry.freeze()
```

```jsonc
{ "scripts": { "taizan:verify-schema": "taizan-verify-schema prisma/schema --registered=Goods,GoodsSku" } }
```

`taizan-verify-schema` 会自动补上框架的 10 张租户表，你只报自己的。它双向比对：
schema 里带 `tenantId` 却没登记 → 红；登记了但 schema 里查无此列 → 红；
`tenantId` 可空 → 红（§3.1 禁止，请拆表）；并带「正则失效防假通过」哨兵。

确实要「带 `tenantId` 但不隔离」时，用 `--allow=Model:理由`，理由不能为空。
框架自己的白名单 `BASE_PLATFORM_ALLOWLIST` **是空的，这是设计目标**：
凡是只需要记录来源租户的平台表，列名一律叫 `originTenantId` / `targetTenantId`
——那不是归属列，不该被隔离校验器当成归属列。

业务项目也可以直接复用本包的约定检查器：

```ts
import { lintSchemaConventions, parsePrismaSchema, formatSchemaLintReport } from '@taizan/prisma-base'

const findings = lintSchemaConventions(parsePrismaSchema(source, file))
expect(findings, formatSchemaLintReport(findings)).toHaveLength(0)
```

---

## 4. 如何加加密列

密钥轮换漏列 = 换完密钥读不出来。所以密文列必须同时做三件事：

1. schema 里加 `xxxEnc String @db.Text` **和配对的 keyId 列**（没有版本号，轮换到一半分不清新旧）；
2. 登记进注册表：

```ts
// src/encrypted-columns.ts（框架的）/ 项目侧同形状的一份
{
  model: 'TenantCredential',
  column: 'valueEnc',
  keyIdColumn: 'keyId',
  description: '租户级三方密钥的密文，接口只回 maskedHint。',
}
```

3. `schema.spec.ts` 自动对账（蓝图 spec 11 的前半）：注册表里的列必须在 schema 里存在、
   配对 keyId 存在、可空性一致；schema 里每个 `*Enc` 列都必须在注册表里。
   后半（轮换脚本覆盖列）在 `@taizan/crypto`。

框架当前的三条：`TenantCredential.valueEnc` / `PlatformSetting.valueEnc` /
`PlatformAdmin.mfaSecretEnc`。明文**永远不落库**，接口只回 `maskedHint`。

---

## 5. seed

```ts
// apps/api/prisma/seed.ts
import { PrismaClient } from '@prisma/client'
import { seedBase } from '@taizan/prisma-base'

const prisma = new PrismaClient() // 原始 client，不要套租户隔离扩展
await seedBase(prisma)
await prisma.$disconnect()
```

产出：平台管理员 `admin` / `admin123`；两档套餐（体验版 STAFF=3、TRAFFIC_MB=0；
标准版 STAFF=null、features=null）；内置角色模板；TRIAL 演示租户 `demo` +
店主 `13800000000` / `123456` + 店内 `owner` 角色。

- 全程 upsert，**重复跑不出事**；
- **不重置已有账号的口令**，也不刷新已有租户的试用期（seed 不能是后门）；
- 套餐价格与配额每次覆盖（seed 是它们的真源）；
- `seedBase(prisma, { withDemoTenant: false })` 只建管理员与套餐，生产初始化用这个；
- `ctx` 是鸭子类型，不 import `PrismaClient`；真实 client 结构上就满足。

口令哈希在 `src/seed/password.ts`，格式 `scrypt$N$r$p$salt$hash`（base64），
由 `@taizan/nest-auth` 复用：`hashPassword` / `verifyPassword` / `needsRehash`。
参数写在串里，以后调高成本参数时老口令还能校验，登录成功时按 `needsRehash` 重算写回。

---

## 6. 本地校验

```bash
pnpm -F @taizan/prisma-base lint typecheck test build
pnpm -F @taizan/prisma-base exec prisma validate --schema schema
```

`prisma validate` 需要能解析 `env("DATABASE_URL")`，包内 `.env` 提供了一个
**不指向任何真实数据库**的占位值，仅供 validate/format 用。

多文件 schema：`prismaSchemaFolder` 在 Prisma 6 已 GA，实测 prisma 6.19.3 直接
`--schema schema` 通过，**不需要** `previewFeatures`。同步到 Prisma 5.15–6.6 的项目
才需要自行补该 preview flag。

---

## 7. 已知取舍

- **MySQL 的唯一索引把 NULL 视为互不相同**，因此 `@@unique([tenantId, phone, deletedAt])`
  在 `deletedAt IS NULL` 时**不能阻止两行活跃重复**。这是蓝图 §3.1「唯一索引必须带
  deletedAt」与 MySQL 语义的固有冲突：带上 `deletedAt` 才能软删后重建同名记录，
  带上之后活跃行的唯一性就得靠应用层（`@taizan/nest-prisma` 的软删扩展 + 业务校验）兜。
  彻底解法是加一列非空的软删判别列（活跃行为 `''`、软删时写唯一值）并把它放进唯一索引，
  但那会改动 `@taizan/nest-prisma` 软删扩展的写路径契约，需要跨包决策，本包不擅自引入。
  受影响的表：`Staff` `Member` `Role` `TenantCredential`。
  作为缓解，**所有真正需要硬唯一的键都放在没有 `deletedAt` 的表上**：
  `Tenant.slug`、`StaffAccount.phone`、`PlatformAdmin.username`、`Plan.code`、
  `PlanOrder.outTradeNo`、`Permission.code`、`Menu.key`、`PlatformSetting.key`、
  `NotifyTemplate.key`、`IdempotencyKey(scope,key)` —— 这些是真约束。
- `Role` / `Staff` 的 seed 用带 `deletedAt: null` 的复合唯一键 upsert。若你的 Prisma
  版本对「复合唯一键里的可空列」有别的行为，改用 `findFirst` + `create` 自行封装。
- 本包不生成 Prisma Client，也不依赖它的运行时类型；`prisma` 是 optional peerDependency，
  只有跑 `prisma validate` / `migrate` 的项目才需要装。
