# @taizan/api

taizan-saas 的唯一后端进程：NestJS 11 模块化单体，三命名空间 + 一个公共面。
它同时是**参考应用**（证明框架各包装得起来）和**生成器模板**（新项目从这里长出来）。

```
/api/platform   平台超管    免租户中间件（平台天然跨租户）
/api/admin      商家后台    只认 staff token 解析租户；解析不到 → 401 而不是 404
/api/client     C 端        X-Tenant-Slug / 子域名选店，失败关闭
/api/public     公共        免登录免租户（注册时店铺还不存在）
```

---

## 1. 本地起步

```bash
# 0) 一次性：装依赖
pnpm install

# 1) 起 MySQL(3307) + Redis(6380)
#    端口刻意避开 3306/6379——这台机器上的老项目 compose 已经占了那两个
pnpm dev:infra

# 2) 建表（第一次会生成 prisma/migrations/<时间戳>_init）
pnpm -F @taizan/api prisma:migrate

# 3) 造数据：平台管理员 + 两档套餐 + 两家演示店 + 5 个商品
#    另外：A 店一个「只有 goods:list」的受限员工、B 店改成**已到期**（计费闸门的对照组），
#    以及把权限点/菜单注册表镜像进 Permission / Menu 表
pnpm -F @taizan/api seed

# 4) 起服务（tsx watch，改代码自动重启）
pnpm -F @taizan/api dev
#    → http://localhost:3000  Swagger 在 /docs
```

停掉基础设施并**清空数据**：`pnpm dev:infra:down`。

### 配置

`.env` 由 `.env.example` 抄一份改。`.env.example` **不要手改**——它由
`src/config/env.ts` 的 zod schema 生成：

```bash
pnpm -F @taizan/api taizan:env-example
```

env 校验在启动期跑（`CoreModule.forRoot`），缺字段会**中文逐条列出**然后拒启，
不会等到第一次用到那个字段才炸。三把 JWT 密钥必须互不相同，
`CRYPTO_KEY_CURRENT` 必须指向 `CRYPTO_KEYS` 里真实存在的 keyId。

---

## 2. 三套身份怎么登录

| 身份 | 接口 | seed 出来的账号 | token 里有什么 |
| --- | --- | --- | --- |
| 平台超管 | `POST /api/platform/auth/login` | `admin` / `admin123` | `kind=platform`，**没有 tenantId** |
| 商家员工 | `POST /api/admin/auth/login` | `13800000000` / `123456`（A 店店主）<br>`13800000001` / `123456`（B 店店主，**已到期**）<br>`13800000002` / `123456`（A 店受限员工，只有 `goods:list`） | `kind=staff`，`tenantId` + `accountId` |
| C 端会员 | `POST /api/client/auth/login-dev` | 任意手机号（需 `CLIENT_DEV_LOGIN=1`） | `kind=member`，`tenantId` |

```bash
# 平台
curl -s localhost:3000/api/platform/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}'

# 商家（名下多店时不发 token，回一张选店列表；带 tenantId 再打一次即可）
curl -s localhost:3000/api/admin/auth/login \
  -H 'content-type: application/json' \
  -d '{"phone":"13800000000","password":"123456"}'

# C 端（靠 X-Tenant-Slug 选店）
curl -s localhost:3000/api/client/auth/login-dev \
  -H 'content-type: application/json' -H 'X-Tenant-Slug: demo' \
  -d '{"phone":"13700000001"}'
```

拿到 access 之后一律 `Authorization: Bearer <access>`。

### 三条必须知道的规则

1. **默认拒绝**。一个什么装饰器都不写的新路由，行为是 `1140100`（未登录）。
   公开必须显式 `@Public()` **且** `@RateLimited(tier)`——
   `test/arch/guard-default-deny.spec.ts` 会把漏写限流的公开路由判为 CI 失败。
   注意「默认拒绝」是**认证**层面的：`@RequirePermission` 没写就不做权限判定
   （否则每条「改自己密码」式的接口都要造一个假权限点）。权限点的完整性靠
   `permission-registry.spec.ts`（spec 6）双向对账。
2. **staff token 一次只绑一家店**。换店走 `POST /api/admin/auth/switch` 重签
   （旧 token 不吊销，支持多标签各开一店；真要踢人靠成员关系每请求现查）。
3. **token 里的租户压过一切请求参数**。`/api/admin/*` 只认 token；
   `X-Tenant-Slug` 只在 `/api/client/*` 且**未登录时**才起作用。

---

## 3. 怎么加一个业务模块（七件事）

以 `src/modules/example-goods/` 为样板，一个模块要动**七处**。下面每一处都给了
example-goods 里的真实代码，照抄改名即可。

| # | 扩展点 | 动哪里 |
| --- | --- | --- |
| ① | 加表 | `prisma/schema/10-business/10-<模块>.prisma` |
| ② | 注册隔离 | `src/tenancy/tenant-models.ts` |
| ③ | 注册权限点 | 模块内 `*.permissions.ts` → `src/registry/permissions.ts` |
| ④ | 注册菜单 | 模块内 `*.menus.ts` → `src/registry/menus.ts` + `src/registry/component-keys.ts` |
| ⑤ | 注册套餐功能项 | `src/registry/features.ts` |
| ⑥ | 注册审计动作 | `src/registry/audit-actions.ts` + 控制器上 `@Audit({...})` |
| ⑦ | 注册队列任务 | 模块内 `*.handler.ts` → `src/registry/jobs.ts` |

### ① 加表

必须 `tenantId String` + `@@index([tenantId, id])` + `deletedAt`；唯一索引带 `deletedAt`。
要用数据范围（`@DataScope`）的表再加一列归属人，并给它一条索引：

```prisma
model Goods {
  id        String    @id @db.VarChar(26)
  tenantId  String    @db.VarChar(26)
  /// 创建人（Staff.id）。@DataScope 的归属列，可空（seed / 队列建的行没有「人」）。
  createdBy String?   @db.VarChar(26)
  deletedAt DateTime?

  @@unique([tenantId, name, deletedAt])
  @@index([tenantId, id])
  @@index([tenantId, createdBy])
}
```

### ② 注册隔离

```ts
// src/tenancy/tenant-models.ts
registry.register(['Goods', 'GoodsSku'])          // 漏登记 = 那张表静默跨租户泄漏
export const SOFT_DELETE_MODELS = new Set(['Goods', 'GoodsSku', /* … */])
```

### ③ 注册权限点 + 控制器上声明

读 / 写 / 删 / 导出**分成四个 code**，不要合成一个 `goods:manage`——合了之后
「实习生能改不能删」这种再普通不过的诉求就没法表达，运营的应对一定是把万能 code 发出去。

```ts
// goods.permissions.ts
export const GOODS_PERMISSIONS = definePermissions({
  'goods:list':   { module: '商品', name: '查看商品',    type: 'API' },
  'goods:write':  { module: '商品', name: '新增/编辑商品', type: 'API' },
  'goods:delete': { module: '商品', name: '删除商品',    type: 'API' },
  'goods:export': { module: '商品', name: '导出商品',    type: 'BUTTON' },
})

// src/registry/permissions.ts —— 汇总一行
export const PERMISSIONS = Object.freeze({ ...GOODS_PERMISSIONS })
```

```ts
// goods.controller.ts
@Get()
@RequirePermission('goods:list')
@DataScope({ ownerField: 'createdBy' })   // 数据范围的归属列，见 ①
list(@Query(Validate(ListGoodsQueryDto)) q: ListGoodsQueryDto,
     @ScopeWhere() scope: Record<string, unknown> | null) {
  return this.goods.list(q, scope)
}
```

```ts
// goods.service.ts —— scope 必须走 mergeScopeWhere
// `null`（不加条件）与 `{}`（空对象条件）不是一回事，直接展开会覆盖同名业务条件。
const where = mergeScopeWhere(q.status ? { status: q.status } : {}, scope)
```

`@DataScope` 只加在**列表/导出**上。单条读写走 `requireOwned(id)`，再叠数据范围会让
「店主帮员工改一条」失败。**导出必须和列表用同一份 scope**——列表加了收窄、导出忘了加，
等于给只能看自己几条的员工开了一键拿走全店数据的口子。

### ④ 注册菜单 + componentKey

```ts
// goods.menus.ts —— 按钮项与页面项是**兄弟**，不是父子
// （defineMenus 明令「非 DIR 不能有 children」）
{ key: 'goods', title: '商品', type: 'DIR', side: 'ADMIN', children: [
  { key: 'goods.list',   title: '商品列表', path: '/goods', componentKey: 'GoodsList',
    type: 'MENU',   side: 'ADMIN', permission: 'goods:list',  featureKey: 'goods' },
  { key: 'goods.create', title: '新增商品',
    type: 'BUTTON', side: 'ADMIN', permission: 'goods:write', featureKey: 'goods' },
]}
```

`permission` ∩ `featureKey` 是**与**的关系，缺一个菜单就不下发。
新增菜单要同步在 `src/registry/component-keys.ts` 里登记 `componentKey`
（spec 7 的临时真源，T3-2 换成扫 `apps/admin`）。

### ⑤ 注册套餐功能项

```ts
// src/registry/features.ts
{ key: 'goods', name: '商品模块', writeOnly: true, pathPrefixes: ['/api/admin/goods'] }
```

`writeOnly: true` = 只拦写不拦读：套餐没含这个模块时已有数据仍然看得见（不然商家会以为
数据丢了），只是新增/改/删被拦成 `1540302`。`pathPrefixes` 写错等于闸门**静默失效**，
由 `billing-routes.spec.ts`（spec 8）与真实 `@Controller` 前缀比对。
**不许盖住 `/api/admin/auth|billing|bootstrap`**——盖住了商家就永远续不了费。

### ⑥ 注册审计动作

```ts
// src/registry/audit-actions.ts
export const APP_AUDIT_ACTIONS = defineAuditActions({ GOODS_CREATE: 'goods.create', /* … */ })
```
```ts
// 控制器上
@Audit({ action: APP_AUDIT_ACTIONS.GOODS_CREATE, targetType: 'Goods' })
```

### ⑦ 注册队列任务

处理器类上的 `@JobHandler({ name })` 才是执行层的真源（`ProcessorFactory` 用
`DiscoveryService` 扫它），`src/registry/jobs.ts` 是给人和平台后台「死信重放」页看的清单。

```ts
// goods-sync.handler.ts
@Injectable()
@JobHandler({ name: 'goods.sync', attempts: 3 })
export class GoodsSyncHandler implements JobProcessor<GoodsSyncPayload> {
  async process(env: JobEnvelope<GoodsSyncPayload>): Promise<void> { /* 抛异常 = 这次失败 */ }
}
```
```ts
// goods.module.ts —— 必须进 providers，否则永远不会被发现（消息入队但没人消费）
providers: [GoodsService, GoodsSyncHandler]
```
```ts
// 入队：tenantId 必须显式传（QueueService 刻意不自动从上下文取）
await this.queue.add('goods.sync', { goodsId, reason: 'create' }, { tenantId })
```

入队要在**写库成功之后、事务之外**：事务里入队的话，事务回滚了消息还在，
worker 会去同步一个不存在的实体。

### 配额：`QuotaService`

```ts
// 顺序不能反：先占配额，再写业务数据。
// 反过来的话超限时数据已经落库了，而回滚一条刚建好的记录比还配额难得多。
await this.quota.consume('CUSTOM')          // 超限抛 1540301（去升套餐）
try {
  row = await this.prisma.tenant.goods.create({ data: autoTenantData({ /* … */ }) })
} catch (e) {
  await this.quota.release('CUSTOM').catch(() => undefined)  // 补偿，别让计数虚高
  throw e
}
// 删除时释放，否则「删 10 个再建 10 个」会超限，而商家看到的数量根本没变
await this.quota.release('CUSTOM')
```

配额维度取自 `QuotaKind` 枚举（框架 schema）。业务自定义维度共用 `CUSTOM`；
要下发到 bootstrap 顶栏的档位登记在 `src/registry/quota-kinds.ts`。

### 四个错误码，各拦各的

| 码 | 谁拦 | 商家该干什么 |
| --- | --- | --- |
| `1340300` | `PermissionsGuard` | 找店主要权限 |
| `1440301` | `BillingGateGuard`（后台到期只读） | 去续费 |
| `1440302` | `TenantGateMiddleware`（C 端打烊） | —— |
| `1540301` | `QuotaService` | 升套餐 / 先清理 |
| `1540302` | `BillingGateGuard`（功能未包含） | 升套餐 |

合成一个笼统的「无权限」，商家不知道该续费、升档、还是删两个员工，只会来问客服。

### 最后

外加一份 `*.rules.ts` 纯函数与它的单测——商业规则不该只能靠起 Nest + 连库才测得到。

改完 schema 后：

```bash
pnpm -F @taizan/api prisma:migrate      # 会先跑 schema-sync 再 migrate dev
pnpm -F @taizan/api taizan:verify-schema # 双向比对隔离名单（arch spec 也会跑）
```

### 写数据访问层时的三条硬约定

```ts
// ✅ 走 prisma.tenant，一个 tenantId 都不写
await this.prisma.tenant.goods.findMany({ where: { status: 'ON_SHELF' } })

// ✅ create 用 autoTenantData：id（ULID）与 tenantId 由扩展注入
//    手写 tenantId 会直接**编译不过**
await this.prisma.tenant.goods.create({
  data: autoTenantData<Prisma.GoodsCreateInput>({ name, priceCents }),
})

// ❌ 手写租户过滤条件。问题不是「写了会错」，是「漏写不会报错」——
//    漏写的那一个查询会安静地返回全平台的数据。
await this.prisma.tenant.goods.findMany({ where: { tenantId, status } })
```

确实需要跨租户（登录找账号、支付回调定位租户、平台后台）时用 `RawPrismaService`，
并在 `src/tenancy/raw-reasons.ts` 登记 + 在用点写 `// raw-reason: <理由>`。
两个条件缺一个，`test/arch/raw-usage.spec.ts` 就红。

### 注入必须显式 `@Inject()`

构建走 tsup（esbuild），**不支持 `emitDecoratorMetadata`**（理由见 `tsup.config.ts`）。
所以：构造函数注入一律 `@Inject(Token)`；DTO 校验用 `@Body(Validate(Dto))` 显式携带
DTO 类（全局 `ValidationPipe` 拿不到 `metatype`，会**静默跳过校验**）；
`@ApiProperty({ type: ... })` 显式写类型。

---

## 4. 框架自带的商家侧管理接口

`/api/admin` 下除了登录、bootstrap、账单，还有五块**每个 SaaS 都要重写一遍**的东西：
员工、角色、审计、公告、个人设置。它们做在框架里（`src/modules/admin/{staff,role,audit,announcement,profile}/`），
判据是「删掉示例业务模块之后，一个新项目仍然需要它」。

### 接口清单

| 方法与路径 | 权限点 | 说明 |
| --- | --- | --- |
| `GET /api/admin/staff` | `staff:list` | 员工分页；关键字同时匹配店内昵称与**登录手机号** |
| `POST /api/admin/staff/invites` | `staff:invite` | 生成邀请令牌。**不扣配额** |
| `PATCH /api/admin/staff/:id` | `staff:write` | 改店内昵称 / 角色。改完立刻生效 |
| `POST /api/admin/staff/:id/disable` | `staff:disable` | 停用。下一个请求就 `1140100` |
| `POST /api/admin/staff/:id/enable` | `staff:disable` | 启用 |
| `POST /api/admin/staff/transfer-owner` | `staff:transfer-owner` | 转让店主。**仅店主本人**（服务层再判一次 `isOwner`） |
| `GET /api/public/invites/:token` | 公开 `lookup` | 查邀请有效性。无效也回 200 + `reason` |
| `POST /api/public/invites/:token/accept` | 公开 `signup` | 核销：手机号 + 密码 → 复用/创建账号 → 建 Staff。**扣配额、不下发 token** |
| `GET /api/admin/roles` | `role:list` | 角色分页，带每个角色挂着几个人 |
| `GET /api/admin/roles/permissions` | `role:list` | 可勾选的权限点目录，按模块分组，已滤掉 `platform-*` |
| `POST /api/admin/roles` | `role:write` | 新建角色 |
| `PATCH /api/admin/roles/:id` | `role:write` | 改角色。改完权限点立刻生效 |
| `DELETE /api/admin/roles/:id` | `role:delete` | 软删。内置的、还有人挂着的都删不掉 |
| `GET /api/admin/audit-logs` | `audit:list` | 本店操作日志。只读，没有写/删接口 |
| `GET /api/admin/announcements` | `announcement:list` | 平台发来的公告（audience 命中 + 在有效期内），附本人已读状态 |
| `POST /api/admin/announcements/:id/read` | `announcement:list` | 标记已读。幂等，不刷新首次已读时间 |
| `GET /api/admin/profile` | `profile:read` | 我的资料 |
| `PATCH /api/admin/profile` | `profile:write` | 改显示名 / 头像（账号级，一号多店时所有店的顶栏一起变） |
| `POST /api/admin/profile/change-password` | `profile:write` | 验旧密码 → 改 → **跨店全端撤销会话** |

### 五个不显然的决定

**配额扣在核销时，不在发邀请时。** 邀请只是一张纸，人没来之前不占名额；
反过来做的话，发 10 张没人用的邀请就把配额占死，而释放它需要一个「撤销邀请」动作
——又一条要维护的路径。核销超限回 `1540301`（升套餐），与到期 `1440301`（续费）是两个码。

**核销端在 `/api/public`，而且不下发 token。** 被邀请人此刻还不是员工、可能连账号都没有，
要求他先登录是个死循环。但在那里签 token 等于开了第二条进后台的路，
而登录接口上的限流与停用判定那里一条都没有——所以核销成功后前端跳登录页。
手机号已有账号时必须验它**现有的**口令，验不过什么都不建、也永远不覆盖原口令。

**店主身份只能通过转让产生。** `canAssignRole`（`@taizan/rbac-core` 的
`ASSIGNABLE_ROLE_RULE`）对店主角色一律返回 `false`，**包括店主自己授予**——
允许店主用「授予角色」把店主身份发出去，就等于绕开了转让流程的审计。
转让后原店主自动降为本店的 `manager`（没有就找 `staff`；两个都没有就保持原样，
**绝不清空** `roleIds`——那会让原店主失去把店转回来的能力）。

**每一处写操作之后都 `invalidate`。** 改角色 → `RolePermissionsService.invalidateRoles(tenantId)`
+ `MembershipProvider.invalidate(accountId, tenantId)`；停用 → `membership.invalidate`；
改密 → `SessionService.revokeAll('staff', staffId)`，且是**这个账号名下所有店**的 staffId
（会话按 `Staff.id` 登记，只撤当前这家店的话，攻击者拿着另一家店的 token 照样在线）。
不调的话最坏 30 秒后才生效——而「把人停了他还在改单」正是那个按钮存在的理由。

**审计不挂 `@DataScope`。** 数据范围要一列「这条数据属于谁」，而 `AuditLog.actorId` 是
「**谁干的**」。按它收窄的语义会变成「只能看自己干过的事」，那恰恰让审计失去意义——
审计的读者是管理者，他要看的就是别人干了什么。「能不能看审计」是一个是非题，
由 `audit:list` 回答，没有中间档。

### 菜单

七个 `componentKey`（`Dashboard` / `StaffList` / `RoleList` / `BillingCenter` /
`AuditList` / `AnnouncementList` / `ProfileSettings`）在 `src/registry/menus.ts` 的
`ADMIN_FRAMEWORK_MENUS` 里登记，`path` 与 `apps/admin/src/App.tsx` 的
`FRAMEWORK_ROUTES` 逐字对齐。`featureKey` **全部留空** = 所有套餐都有：
把「员工管理」做成付费功能意味着一家没续费的店连人都管不了，
而它此刻最该做的事之一恰恰是把离职的人停掉。

工作台与账单**不挂 `permission`**（前者是登录后的落地页，裁掉就是 404；
后者到期时人人都得看得到「去续费」）；其余五条的 `permission` 与对应路由上的
`@RequirePermission` **逐条对齐**——两边不一致的表现只有「看得到点进去 403」
或者「菜单里没有接口却能调」，两种都比「这个人看不到这一页」难解释得多。

---

## 5. 测试

```bash
pnpm -F @taizan/api test        # 单测 + 架构约束 spec，不连库
pnpm -F @taizan/api test:e2e    # 隔离 e2e，连 compose 起的真库
```

### 架构约束 spec（`test/arch/`，蓝图 §8）

| spec | 守什么 |
| --- | --- |
| `tenant-models.spec.ts`（#1） | 隔离名单 ↔ schema 双向比对 + 解析器哨兵；软删名单同样双向比对 |
| `raw-usage.spec.ts`（#3） | raw 逃生口只在白名单目录，且每处有 `// raw-reason:` |
| `no-manual-tenant-filter.spec.ts`（#4） | 业务模块的 `where` 里不许出现 `tenantId` 键 |
| `guard-default-deny.spec.ts`（#5） | 每条路由要么被守卫覆盖要么 `@Public()`；公开路由必须有限流档位 |
| `permission-registry.spec.ts`（#6） | `@RequirePermission` ↔ 权限点注册表**双向**：拼错的 code、没人引用的死权限 |
| `menu-route-map.spec.ts`（#7） | 菜单 ↔ `componentKey` 清单：白屏路由、没登记的组件、引用了未注册权限点的菜单 |
| `billing-routes.spec.ts`（#8） | 续费白名单 ↔ 真实控制器前缀 ↔ 功能项前缀，三方对账 |
| `cluster-safe.spec.ts`（#12） | 裸 `setInterval` / `@Cron` / 一次性凭据 `get(` / 长驻 Map・Set |
| `guard-order.spec.ts` | 守卫链与拦截器链顺序恒定，且**只有一处**注册点 |
| `base-schema-integrity.spec.ts`（#15） | `00-base/**` 的 sha256 与 `base.lock.json` 一致 |
| `tenant-middleware.spec.ts`（#16） | 四条命名空间的租户解析口径与控制器前缀比对 |

每个 spec 都带**哨兵**：扫描器失效时哨兵先炸，而不是让真实代码「一个问题都没扫到」地
假通过——「扫不到东西」和「没有问题」在断言上长得一模一样。

### RBAC + 计费 e2e（`test/rbac-billing.e2e-spec.ts`）

33 条用例，同样跑真库。覆盖：只有 `goods:list` 的员工写被拦 `1340300`、
bootstrap 的菜单里没有「新增」按钮项、店主拿到全部注册权限点、
到期租户写 `1440301` 读通且续费白名单可写、C 端 `1440302`、
`features: []` → `1540302`、`quotas: { CUSTOM: 0 }` → `1540301`、
`goods.sync` 入队后 handler 被执行且 traceId 链正确、
冻结租户被硬闸门拦下、`BILLING_ENFORCE=false` 时放行但打 warn、
`dataScope: 'SELF'` 的员工只看得到自己建的商品（列表与导出同一份 scope）。

计费开关不靠改 env——`BillingModule.forRoot()` 在模块求值时就读 `process.env`，
而 ESM 的 import 是提升的。测试用 `overrideProvider(BILLING_OPTIONS)` 换掉它。

### 商家侧管理面 e2e（`test/admin-management.e2e-spec.ts`）

44 条用例，跑真库。覆盖：员工列表按手机号搜（手机号在平台域表上，要跨过去取）、
邀请不扣配额 → 核销扣一格 → 新员工能登录、同一张邀请核销两次被拒、
`STAFF` 配额为 0 时核销 `1540301` **且抢占的 `usedAt` 被回滚**、
改角色后**下一个请求**就生效、停用后立刻 `1140100`、不能停自己也不能停店主、
店主角色谁都授予不了（含店主自己）、转让店主后原店主失去 OWNER-only 能力、
角色 CRUD + `platform-*`/通配/未注册码三种拒绝 + 内置角色保护 + 引用中不可删、
审计只含本租户、公告按 audience 可见（`ALL_TENANT`/`PLAN`/`TENANT_IDS` 命中，
点名别家的与 `C_END` 的看不到）+ 已读幂等、改密后旧 token 失效且新密码可登录、
bootstrap 的菜单里有七个框架页且受限员工看不到 `staff`/`role`/`audit`/`announcement`/`profile`。

邀请核销走 `signup` 档限流（`clientLimit: 3 / 24h`，**成功也计数**），所以每次核销
都带一个独立的伪 `X-Forwarded-For`——不分桶的话第 4 次会变成 `1042900`，
而那会让一条本该验证配额的用例**因为错误的原因**红掉。

### 隔离 e2e（`test/tenant-isolation.e2e-spec.ts`）

41 条用例，跑在真 MySQL/Redis 上。每次运行新建一对租户（slug 带随机后缀），
所以可重复跑、也不污染 seed 出来的演示店。覆盖：跨租户读写一律 `1240300`、
请求参数携带别家 tenantId 无效、无 token 是 `1140100` 而不是 `1240400`、
C 端 slug 头压不过 token、软删是软的、**事务回滚会把软删一起回滚**、
`@Audit` 落表且 tenantId 正确、Swagger 可访问。

---

## 6. 目录

```
src/
├─ bootstrap/     main / app.module / global-providers（守卫顺序一处定死）/ configure-app
├─ config/        env.ts —— env 契约的单一真源，.env.example 由它生成
├─ common/        Validate() 校验管道、Prisma 类型收窄与 autoTenantData
├─ tenancy/       隔离名单、解析策略配置、raw 白名单
├─ registry/      五张注册表：权限点 / 菜单 / 套餐功能项 / 审计动作 / 队列任务
│                 外加三份辅助清单：component-keys（spec 7 临时真源）/
│                 quota-kinds（bootstrap 下发哪几档配额）/ notify-templates
├─ modules/
│  ├─ platform/   /api/platform（登录、租户开通与列表）
│  ├─ admin/      /api/admin（登录/换店/登出、bootstrap）
│  ├─ client/     /api/client（会员登录、商品列表）
│  ├─ public/     /api/public（健康回声）
│  └─ example-goods/  示例业务模块，生成器可整目录删除
├─ notify/        通知通道装配（INBOX + mock 短信）
└─ seed.ts        幂等 seed（+ seed-delegates.ts 适配 Prisma 的唯一键行为）
```

守卫链与拦截器链的顺序**全仓只在 `src/bootstrap/global-providers.ts` 一处定死**：

```
守卫    [RateLimitGuard(T2-6)] → GlobalAuthGuard → PermissionsGuard → BillingGateGuard
拦截器  TransformInterceptor(CoreModule) → DataScopeInterceptor → AuditInterceptor
```

Nest 的全局守卫按「模块实例化顺序 → 数组顺序」执行，让各框架包自己挂 `APP_GUARD`
就等于把顺序交给 import 图的副产物——而顺序错了的表现是**放行**，不是报错：
`BillingGateGuard` 排到认证前面会读不到 `principal.kind`，于是直接 `return true`，
整条计费闸门静默失效，一条 e2e 都不会红。所以 `guard-order.spec.ts` 静态读那两个数组
逐项比对，并断言除这个文件外没有第二处出现 `APP_GUARD` / `APP_INTERCEPTOR`。

---

## 7. 已知取舍与待办

- **`prisma.config.ts` 而不是 `package.json#prisma`**：多文件 schema 下 Prisma 会把
  migrations 放在「含 datasource 的那个片段」旁边，也就是框架托管的 `00-base/`。
  只有 `migrations.path` 能把迁移历史挪出来。
- **建租户还是两条路**：`/api/platform/tenants` 里那个事务是临时的，
  T1-8 会整体换成 `@taizan/provision`（蓝图 spec 14）。文件头有 TODO。
- **平台侧还没有细粒度权限**：`PermissionsGuard` 对 `kind === 'platform'` 直接放行。
  平台超管在本框架里是全权身份，约束靠「谁能拿到 platform token」+ `@Audit()` 全量审计兜。
  等 `RolePreset.side = 'PLATFORM'` 落地（T1-7）再改成按平台自己的角色判定。
- **`/api/admin/billing` 只有读**：下单、支付、回调核销、`PlanOrder` 状态机在 T1-5。
  现在这条 `GET` 兑现的是续费白名单里的那条前缀（spec 8 看着），
  并让前端画得出「套餐 / 到期日 / 只读中 / 配额用量」这一屏。
- **`/api/admin/bootstrap` 是 `/api/admin/auth/bootstrap` 的别名**：白名单里两条前缀都要
  有真实控制器兑现，而四端协议写的是后者。两条 URL 转发到同一个 service 方法，不会漂。
- **`bootstrap.readonly` 恒按 `enforcing: true` 算**，与守卫看真实开关刻意不同：
  灰度期要先让商家看到「到期了」，再真的开始拦。方向是「前端置灰、后端放行」，偏保守。
- **内置角色模板的 `permissionCodes` 还是空的**：`@taizan/prisma-base` 的
  `BASE_ROLE_PRESETS` 里 `manager` / `staff` 两档给的是 `[]`（框架不替业务猜权限码）。
  后果是一个只被授予了 `staff` 角色的员工**连自己的资料都看不到**（`profile:read` 没给）。
  业务项目落地时应当在自己的角色模板里把 `profile:*` / `announcement:list` 这类
  「人人都该有」的码补上；框架侧不硬塞，因为「哪些算人人都该有」是产品决定。
- **`billing:*` 权限点仍然没注册**：`/api/admin/billing` 上到今天还没有 `@RequirePermission`
  （理由见那个控制器的文件头）。凭空注册一个 `billing:pay` 只会多一个死权限（spec 6 会红），
  所以它跟着「要不要收紧下单」那个决定一起落。
- **商家侧公告只有「读平台发来的」**：`apps/admin/src/api/announcements.ts` 那份 mock 写的是
  「商家自己发店内公告」的 CRUD，但 `06-ops.prisma` 里的 `Announcement` 是**平台域**表。
  店内公告是一个独立的业务需求，要走七件事的完整流程（先加一张租户域表）。
- **公告可见性在内存里判**：`audience = PLAN / TENANT_IDS` 的目标集合存在 `audienceRefs`
  这个 Json 列里，MySQL 上按数组元素过滤要 `array_contains`，而那个写法在 Prisma 的 TS
  类型上很脆——写错了不会报错、只会静默漏掉一批公告。所以 SQL 只筛「已发布 + 在有效期内」，
  最多拉 500 条回内存再过滤。到了那个量级该给公告加一张收件人展开表，而不是调大这个数。
- **`invalidate` 只清本进程**：`PlatformGateway` 与 `RolePermissionsService` 的缓存都是
  进程内 Map，多实例下续费/改权限的最坏生效延迟仍是 30 秒。跨实例失效要等 T2-1 的
  Redis 广播。
- **`goods.sync` 是个只打日志的示例**：它证明的是接线（worker 起来了、traceId 链串得回去、
  租户上下文恢复了），不是业务。真实处理器在这三件事之上才开始写自己的逻辑。
- **通知只装了 INBOX + mock 短信**：`MP_TEMPLATE` / `APP_PUSH` **一个都不装**而不是装 noop
  ——装了 noop 的话业务代码会拿到 `ok: true`，「推送没到」就变成看不出来的状态。
- **活跃商品名的唯一性靠应用层兜**：MySQL 把唯一索引里的 `NULL` 视为互不相同，
  所以 `@@unique([tenantId, name, deletedAt])` 挡不住两行活跃同名记录
  （`@taizan/prisma-base` README §7）。并发下仍有窗口。
- **cron 还一个都没有**：`@LeaderCron` 已经随 `InfraModule` 装上，但业务侧暂时没有
  定时任务。加的时候直接写 `@LeaderCron`，裸 `@Cron` / `setInterval` 会被
  `cluster-safe.spec.ts`（spec 12）拦下。
