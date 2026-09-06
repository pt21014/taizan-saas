# 扩展点手册：加一个业务模块

框架把「一个业务模块要接上多租户 SaaS 的哪些东西」压成了**七件事**，每件一行代码或一个文件。
本文以 `apps/api/src/modules/example-goods/`（示例商品模块）为样板逐文件讲一遍，
末尾给一份可以照着打勾的 checklist 和三个最常见的错误。

> `example-goods` 是**可删的**：生成器交互第 8 问选「不保留示例模块」时会整目录删掉，
> 连同它的 schema 片段、权限点、菜单、功能项、审计动作与队列任务。
> 所以它里面的每一行都刻意写成「照抄改名即可」的形状。

相关文档：`apps/api/README.md` §3（同一份内容的速查版）、`packages/admin-ui/README.md`（前端侧）、
`docs/SECURITY-INVARIANTS.md`（下面每一条红线的完整说明）。

---

## 0. 先看一眼全景

```
后端七件事                                          前端两件事
────────────────────────────────────────────────   ──────────────────────────
① prisma/schema/10-business/10-goods.prisma        ⓐ apps/admin/src/routes/component-map.ts
② src/tenancy/tenant-models.ts                     ⓑ apps/admin/src/pages/goods/GoodsListPage.tsx
③ src/modules/example-goods/goods.permissions.ts
   → src/registry/permissions.ts
④ src/modules/example-goods/goods.menus.ts
   → src/registry/menus.ts + src/registry/component-keys.ts
⑤ src/registry/features.ts
⑥ src/registry/audit-actions.ts + 控制器 @Audit()
⑦ src/modules/example-goods/goods-sync.handler.ts
   → src/registry/jobs.ts
```

七件事漏掉任何一件，**表现都不是报错**：

| 漏了哪件 | 表现 |
| --- | --- |
| ① 少 `tenantId` / 索引 | 表没法隔离；或列表页在数据量上来后慢到超时 |
| ② 没登记 `TENANT_MODELS` | **那张表完全没有租户隔离，且不报错** |
| ③ 权限点没注册 | 路由永远 `1340300`，运行时一句报错都没有 |
| ④ 菜单没注册 / `componentKey` 没登记 | 商家找不到入口；或点进去白屏 |
| ⑤ 功能项没登记 | 套餐没含这个模块的商家照样能用 |
| ⑥ 审计没登记 | 出事之后查不到是谁点的 |
| ⑦ 队列任务没登记 | 消息入队但**没人消费**，队列静静地涨 |

前六件有 spec 拦着（下面每节都写了是哪个）。

---

## 1. 后端七件事，逐文件

### ① 加表 — `apps/api/prisma/schema/10-business/10-goods.prisma`

业务片段一律放 `10-business/`，**绝不能写进 `00-base/`**（那是框架托管目录，
`apps/api/test/arch/base-schema-integrity.spec.ts` 拿 `base.lock.json` 的 sha256 盯着）。

```prisma
model Goods {
  id        String       @id @db.VarChar(26)
  tenantId  String       @db.VarChar(26)
  name      String
  priceCents Int
  status    GoodsStatus  @default(DRAFT)
  /// 创建人（Staff.id）。@DataScope 的归属列，可空（seed / 队列建的行没有「人」）。
  createdBy String?      @db.VarChar(26)
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
  deletedAt DateTime?

  @@unique([tenantId, name, deletedAt])
  @@index([tenantId, id])
  @@index([tenantId, createdBy])
}

enum GoodsStatus { DRAFT ON_SHELF OFF_SHELF }
```

必须做到的五条（蓝图 §3.1）：

| 约定 | 为什么 |
| --- | --- |
| `tenantId String` **NOT NULL** | 可空 tenantId 就是「例外」，例外一定会在某次重构里被忘掉。需要「平台共享 + 租户私有」的一律**拆成两张表**（框架自己的 `RolePreset` / `Role` 就是这么拆的） |
| `@@index([tenantId, id])` | 隔离扩展给每个 where 都加了 `tenantId`，没这条索引等于全表扫 |
| 金额 `Int` + 名字以 `Cents` 结尾，禁 `Decimal` | 对账口径只能有一个 |
| 状态用 `enum`，主键 `String`（ULID，应用层生成） | 裸 Int/String 状态迟早出现「3 是什么意思」 |
| 唯一索引带 `deletedAt` | 否则软删之后重建同名记录会撞唯一键。**注意 MySQL 把 NULL 视为互不相同**，活跃行的唯一性仍要应用层兜（`packages/prisma-base/README.md` §7） |

**不要建指向 `Tenant` 的外键**，一条 relation 都不要建：将来平台侧要能平移成独立控制面服务，外键会挡路。

### ② 注册隔离 — `apps/api/src/tenancy/tenant-models.ts`

```ts
registry.register(['Goods', 'GoodsSku'])   // ← 就这一行

export const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set([
  /* 框架侧… */ 'Goods', 'GoodsSku',
])
```

两份清单**不能互相推导**：`AuditLog` 是租户域但没有软删（审计不允许被删），
平台域表将来也可能有软删。两份都由 `apps/api/test/arch/tenant-models.spec.ts` 与 schema 双向比对。

> **漏登记 `TENANT_MODELS` 会怎样**：见下面第 4 节。这是本框架第一号红线。

### ③ 注册权限点 — `goods.permissions.ts` → `src/registry/permissions.ts`

```ts
// apps/api/src/modules/example-goods/goods.permissions.ts
export const GOODS_PERMISSIONS = definePermissions({
  'goods:list':   { module: '商品', name: '查看商品',      type: 'API' },
  'goods:write':  { module: '商品', name: '新增/编辑商品', type: 'API' },
  'goods:delete': { module: '商品', name: '删除商品',      type: 'API' },
  'goods:export': { module: '商品', name: '导出商品',      type: 'BUTTON' },
})

// apps/api/src/registry/permissions.ts —— 汇总一行
export const PERMISSIONS = Object.freeze({ ...GOODS_PERMISSIONS })
```

**读 / 写 / 删 / 导出分成四个 code**，不要合成一个 `goods:manage`。合了之后
「实习生能改不能删」这种再普通不过的诉求就没法表达，运营的应对一定是把万能 code 发出去。

控制器上：

```ts
@Get()
@RequirePermission('goods:list')                 // 支持 'a|b'（或）与 ['a','b']（与）
@DataScope({ ownerField: 'createdBy' })          // 只加在列表/导出上
list(@Query(Validate(ListGoodsQueryDto)) q: ListGoodsQueryDto,
     @ScopeWhere() scope: Record<string, unknown> | null) {
  return this.goods.list(q, scope)
}
```

service 里 scope **必须走 `mergeScopeWhere`**——`null`（不加条件）与 `{}`（空对象条件）不是一回事，
直接展开会覆盖同名业务条件：

```ts
const where = mergeScopeWhere(q.status ? { status: q.status } : {}, scope)
```

单条读写走 `requireOwned(id)`，不要再叠数据范围（否则「店主帮员工改一条」会失败）。
**导出必须和列表用同一份 scope**——列表加了收窄、导出忘了加，等于给只能看自己几条的员工
开了一键拿走全店数据的口子。

守卫：`apps/api/test/arch/permission-registry.spec.ts` 双向对账（拼错的 code、没人引用的死权限）。

### ④ 注册菜单 — `goods.menus.ts` → `src/registry/menus.ts` + `component-keys.ts`

```ts
{ key: 'goods', title: '商品', type: 'DIR', side: 'ADMIN', children: [
  { key: 'goods.list',   title: '商品列表', path: '/goods', componentKey: 'GoodsList',
    type: 'MENU',   side: 'ADMIN', permission: 'goods:list',  featureKey: 'goods' },
  { key: 'goods.create', title: '新增商品',
    type: 'BUTTON', side: 'ADMIN', permission: 'goods:write', featureKey: 'goods' },
]}
```

三件容易错的事：

1. **按钮项与页面项是兄弟，不是父子**（`defineMenus` 明令「非 `DIR` 不能有 `children`」）；
2. `permission` ∩ `featureKey` 是**与**的关系，缺一个菜单就不下发；
3. `componentKey` 要同步登记在 `apps/api/src/registry/component-keys.ts`（当前是 spec 7 的临时真源）
   **以及**前端的 `component-map.ts`。

守卫：`apps/api/test/arch/menu-route-map.spec.ts` + `apps/admin/src/routes/component-map.spec.ts`。

### ⑤ 注册套餐功能项 — `apps/api/src/registry/features.ts`

```ts
{ key: 'goods', name: '商品模块', writeOnly: true, pathPrefixes: ['/api/admin/goods'] }
```

`writeOnly: true` = **只拦写不拦读**：套餐没含这个模块时已有数据仍然看得见
（不然商家会以为数据丢了），只是新增/改/删被拦成 `1540302`。

`pathPrefixes` 写错等于闸门**静默失效**。守卫：`apps/api/test/arch/billing-routes.spec.ts`
拿真实 `@Controller` 前缀比对，并断言**不许盖住 `/api/admin/auth|billing|bootstrap`**
——盖住了商家就永远续不了费。

### ⑥ 注册审计动作 — `apps/api/src/registry/audit-actions.ts`

```ts
export const APP_AUDIT_ACTIONS = defineAuditActions({
  GOODS_CREATE: 'goods.create',
  GOODS_DELETE: 'goods.delete',
})
```

```ts
@Delete(':id')
@RequirePermission('goods:delete')
@Audit({ action: APP_AUDIT_ACTIONS.GOODS_DELETE, targetType: 'Goods', captureBefore: true })
remove(@Param('id') id: string) { return this.goods.remove(id) }
```

拦截器自动填 actor（从上下文）、ip、traceId、result、耗时、请求体脱敏。
`captureBefore: true` 要求所在 service 实现 `AuditSnapshot`。
平台身份写 `PlatformAuditLog`，商家身份写 `AuditLog`——两张表，不是一张带可空 tenantId 的表。

### ⑦ 注册队列任务 — `goods-sync.handler.ts` → `src/registry/jobs.ts`

```ts
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

两条时序纪律：

- **入队要在写库成功之后、事务之外**。事务里入队的话，事务回滚了消息还在，
  worker 会去同步一个不存在的实体。
- 类上的 `@JobHandler` 才是执行层真源（`ProcessorFactory` 用 `DiscoveryService` 扫它）；
  `src/registry/jobs.ts` 是给人和平台后台「死信重放」页看的清单，两边都要有。

### 附：配额

```ts
// 顺序不能反：先占配额，再写业务数据。
await this.quota.consume('CUSTOM')          // 超限抛 1540301
try {
  row = await this.prisma.tenant.goods.create({ data: autoTenantData({ /* … */ }) })
} catch (e) {
  await this.quota.release('CUSTOM').catch(() => undefined)   // 补偿，别让计数虚高
  throw e
}
// 删除时释放，否则「删 10 个再建 10 个」会超限，而商家看到的数量根本没变
await this.quota.release('CUSTOM')
```

反过来（先写数据再占配额）的话，超限时数据已经落库了，而回滚一条刚建好的记录比还配额难得多。
业务自定义维度共用 `QuotaKind.CUSTOM`；要下发到 bootstrap 顶栏的档位登记在 `src/registry/quota-kinds.ts`。

### 附：数据访问层的三条硬约定

```ts
// ✅ 走 prisma.tenant，一个 tenantId 都不写
await this.prisma.tenant.goods.findMany({ where: { status: 'ON_SHELF' } })

// ✅ create 用 autoTenantData：id（ULID）与 tenantId 由扩展注入；手写 tenantId 直接编译不过
await this.prisma.tenant.goods.create({
  data: autoTenantData<Prisma.GoodsCreateInput>({ name, priceCents }),
})

// ❌ 手写租户过滤条件
await this.prisma.tenant.goods.findMany({ where: { tenantId, status } })
```

确实需要跨租户时用 `RawPrismaService`，并**同时**做两件事：在 `src/tenancy/raw-reasons.ts` 登记，
在用点写 `// raw-reason: <理由>`。缺一个 `apps/api/test/arch/raw-usage.spec.ts` 就红。

### 附：注入必须显式 `@Inject()`

构建走 tsup（esbuild），**不支持 `emitDecoratorMetadata`**。所以构造函数注入一律 `@Inject(Token)`；
DTO 校验用 `@Body(Validate(Dto))` 显式携带 DTO 类（全局 `ValidationPipe` 拿不到 `metatype`，
会**静默跳过校验**）；`@ApiProperty({ type: ... })` 显式写类型。

---

## 2. 前端两步

> `apps/admin` / `apps/platform` 由 T3-1 ~ T3-4 建设，**进行中**。下面的形状以
> `packages/admin-ui/README.md` 与 `apps/admin/src/routes/component-map.ts` 的当前实现为准。

### ⓐ 注册 componentKey — `apps/admin/src/routes/component-map.ts`

```tsx
import { lazy } from 'react'
import { defineComponentMap } from '@taizan/admin-ui'

export const componentMap = defineComponentMap({
  GoodsList: lazy(() => import('../pages/goods/GoodsListPage')),
})
```

服务端只下发 `componentKey`，**不下发前端文件路径**——把前端目录结构写进数据库，
以后前端换个目录就得改数据。`buildRoutes()` 遇到没登记的 key 会 `console.warn` 并**跳过**
（跳过而不是渲染空组件：少一条路由至少会落到兜底 404）。

对账靠 `apps/admin/src/routes/component-map.spec.ts` 里的 `verifyComponentMap()`，
三项都要为空：`missing`（菜单引用了、映射表没有 → 白屏）、`unused`（映射表有、没菜单引用 → 死代码，
或者菜单漏注册导致页面永远进不去）、`pathWithoutComponentKey`。

### ⓑ 写页面 — 41 行范式

```tsx
import { Form, Input } from 'antd'
import { CrudDrawerForm, CrudTable, useCrudForm, useCrudTable } from '@taizan/admin-ui'
import { useGoodsApi, type Goods, type GoodsInput } from '../api/goods'

export default function GoodsListPage() {
  const api = useGoodsApi()
  const table = useCrudTable<Goods>({
    list: api.list, remove: api.remove, rowKey: 'id',
    searchSchema: [{ name: 'keyword', label: '名称' }],
  })
  const form = useCrudForm<GoodsInput>({
    get: api.get, create: api.create, update: api.update, onSuccess: table.refresh,
  })
  return (
    <>
      <CrudTable
        table={table}
        title="商品"
        create={{ label: '新增商品', perm: 'goods:write', onClick: () => form.openForm() }}
        columns={[
          { title: '名称', dataIndex: 'name', key: 'name' },
          { title: '价格（分）', dataIndex: 'priceCents', key: 'priceCents' },
        ]}
        actions={[
          { key: 'edit', label: '编辑', perm: 'goods:write', onClick: (r) => form.openForm(r.id) },
          { key: 'del',  label: '删除', perm: 'goods:delete', onClick: table.removeRow },
        ]}
      />
      <CrudDrawerForm form={form} title="商品">
        <Form.Item name="name" label="名称" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
      </CrudDrawerForm>
    </>
  )
}
```

这 41 行（含 import）里已经包含：分页、搜索、排序、按钮级权限、删除确认、新建/编辑两态与回填、
提交态、`1440301`/`1540301` 的错误码分流、只读态自动禁用提交。
**页面里没有一行 `useState`，也没有一行 `useEffect`**——有的话说明你在重新实现 hooks 已经做过的事。

按钮权限的 `perm` 与后端权限点同名。完整说明见 `packages/admin-ui/README.md`。

---

## 3. 完整 checklist

复制到 PR 描述里逐条打勾。

**后端**

- [ ] ① `apps/api/prisma/schema/10-business/10-<模块>.prisma`：`tenantId` NOT NULL、`@@index([tenantId, id])`、`deletedAt`、唯一索引带 `deletedAt`、金额 `*Cents Int`、状态 enum、主键 `String`、零 relation
- [ ] ② `src/tenancy/tenant-models.ts`：`registry.register([...])` **和** `SOFT_DELETE_MODELS`（两份都要）
- [ ] ③ `<模块>.permissions.ts` + 汇总进 `src/registry/permissions.ts`；控制器上 `@RequirePermission`；列表/导出加 `@DataScope`，service 用 `mergeScopeWhere`
- [ ] ④ `<模块>.menus.ts` + 汇总进 `src/registry/menus.ts` + `src/registry/component-keys.ts`；`permission` 与 `featureKey` 都填
- [ ] ⑤ `src/registry/features.ts`：`key` / `writeOnly` / `pathPrefixes`（不许盖住续费白名单三条前缀）
- [ ] ⑥ `src/registry/audit-actions.ts` + 写操作控制器上 `@Audit`
- [ ] ⑦ `<模块>-*.handler.ts` 上 `@JobHandler` + 进 `providers` + 汇总进 `src/registry/jobs.ts`；入队在事务之外
- [ ] 一份 `<模块>.rules.ts` 纯函数 + 它的 `.spec.ts`（商业规则不该只能靠起 Nest + 连库才测得到）
- [ ] 需要配额的：`quota.consume` 在写库**之前**，失败 `release` 补偿，删除时 `release`
- [ ] 需要跨租户的：`RawPrismaService` + `raw-reasons.ts` 登记 + `// raw-reason:` 注释

**前端**

- [ ] ⓐ `apps/admin/src/routes/component-map.ts` 登记 `componentKey`
- [ ] ⓑ 页面用 `useCrudTable` / `useCrudForm`；按钮 `perm` 与后端权限点同名

**跑一遍**

```bash
pnpm -F @taizan/api prisma:migrate        # 会先 schema-sync 再 migrate dev
pnpm -F @taizan/api taizan:verify-schema  # 双向比对隔离名单
pnpm -F @taizan/api test                  # 单测 + 全部 arch spec
pnpm -F @taizan/api test:e2e              # 隔离 e2e，连真库
pnpm -F @taizan/admin test                # component-map 对账
```

---

## 4. 三个最常见的错误

### 4.1 漏登记 `TENANT_MODELS` 会怎样

**会静默跨租户泄漏。** 隔离扩展只对注册过的 model 生效：没登记的 model，
`prisma.tenant.xxx.findMany()` 走的是 `passthrough` 分支——它**照样能跑、照样返回结果**，
只是结果里混着全平台所有租户的行。

- 开发环境发现不了：本地只有一个租户，全平台 = 这个租户。
- 测试也发现不了：除非你专门造两个租户交叉验证（`apps/api/test/tenant-isolation.e2e-spec.ts` 就是干这个的）。
- 这是 xiaodian 2026-08 的真实事故形态。

**谁拦**：`apps/api/test/arch/tenant-models.spec.ts` 扫全部 `prisma/schema/**/*.prisma`，
带 `tenantId` 的 model 不在清单里就红；反向（清单里有、schema 里没这列）也红。
它还带一个「正则失效防假通过」哨兵——故意塞一段已知含 `tenantId` 的文本，解析不出来就直接红。

**真要「带 tenantId 但不隔离」怎么办**：`taizan-verify-schema --allow=Model:理由`，
理由不能为空。但先想想是不是该改名：框架自己的白名单是**空的**，
凡是只需要记录来源租户的平台表，列名一律叫 `originTenantId` / `targetTenantId`
（`JobDeadLetter` / `OutboxEvent` / `PlatformAuditLog` / `PlatformNotifyRecord` 都是这么起的）
——那不是归属列，不该被隔离校验器当成归属列。

### 4.2 手写 `tenantId` 会被哪个 spec 拦

**`apps/api/test/arch/no-manual-tenant-filter.spec.ts`**：扫业务模块源码，
禁止字面量 `tenantId:` 出现在 `where` 上下文（`src/modules/platform/` 与 raw 白名单除外）。

create 路径上还有第二道防线：`autoTenantData<T>()` 的类型签名把 `tenantId` 从入参里剔掉了，
手写会**直接编译不过**——比测试早一步。

为什么要拦「看起来正确」的写法：因为它把一条不变量（框架保证隔离）换成了一条纪律
（每个人每次都记得写）。纪律的失败模式是**漏写不报错**，而框架的失败模式是抛错。
两者在正常路径上表现完全一样，只在出事时不一样。

### 4.3 忘了给 `@Public()` 路由加 `@RateLimited` 会怎样

**`apps/api/test/arch/guard-default-deny.spec.ts` 会红**，CI 直接失败。

规则是：每个 `@Controller` 的每个路由方法，要么被全局守卫覆盖（默认拒绝），
要么显式 `@Public()`；而 `@Public()` 的路由**必须同时声明限流档位**。

如果这条没有被拦住：免登录接口是唯一能被无成本刷的入口。
发短信验证码那种接口漏了限流，一夜的短信账单就能超过整月营收；
注册接口漏了限流，攻击者能把 slug 全占了。

顺带三条容易混淆的：

- **「默认拒绝」是认证层面的**。`@RequirePermission` 没写就是不做权限判定
  （否则每条「改自己密码」式的接口都要造一个假权限点）。权限点完整性靠
  `apps/api/test/arch/permission-registry.spec.ts` 双向对账。
- 限流取 IP 只能用 `resolveIps`，不能读 `x-forwarded-for` 第一段——
  `apps/api/test/arch/ip-source.spec.ts` 拦着，理由见 `docs/SECURITY-INVARIANTS.md` K6。
- `/api/public/*` 不进租户中间件（注册时店铺还不存在），
  由 `apps/api/test/arch/tenant-middleware.spec.ts` 与控制器前缀比对。

---

## 5. 用 codegen 一次生成

```bash
pnpm gen:module goods
```

`tools/codegen` 的 plop 模板一次生成上面全部七处 + 一个 `*.rules.ts` 纯函数 + 三个 spec，
模板内置 `tenantId` 过滤与权限装饰器。手写七处的问题不是麻烦，是**第五处开始就会漏**。

> `tools/codegen` 属 T4-1 范围，**进行中**。在它可用之前，照抄 `example-goods` 目录改名。
