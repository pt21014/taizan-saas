# CI 与架构约束（T4-2）

本仓库的 CI 由三个 workflow 组成（第三个是**交付判据**，不是普通检查）：

| 文件 | 何时跑 | 干什么 |
|---|---|---|
| `.github/workflows/ci.yml` | PR + push main | 五个并行 job：`quality` / `unit` / `arch` / `api-e2e` / `migrate-check` |
| `.github/workflows/release.yml` | push main | changesets 两段式发布（T4-6，见 `docs/RELEASE.md`） |
| `.github/workflows/generator-e2e.yml` | 每天定时 + 生成器/包变动的 PR + 手动 | **验收判据**：蓝图 §6 的 9 条，等价于本地 `pnpm acceptance`（见 §5） |

设计取舍只有一条值得写在最前面：**五个 job 互相不 `needs`，全部并行**。串起来能省点 runner
分钟数，但会把 lint 的 30 秒堵在 e2e 的 5 分钟后面。CI 的价值在于多快告诉你坏了。
总时长 = 最慢的 job，目标 <10 分钟。

---

## 1. 各 job 做什么 · 本地等价命令

### `quality` —— 静态检查与「文档/依赖是否同步」

| CI 步骤 | 本地等价 | 守什么 |
|---|---|---|
| Lint | `pnpm lint` | eslint（turbo 分发到各包） |
| Typecheck | `pnpm typecheck` | `tsc --noEmit` |
| Format check | `pnpm format:check` | prettier |
| Check peer deps | `pnpm check:peer-deps` | 零框架依赖的包，`dependencies` 里不许出现 `@nestjs/*` / `@prisma/client`（T4-6） |
| Check changeset（仅 PR） | `node scripts/check-changeset.mjs --staged` | 改了 `packages/*/src` 就必须带 changeset |
| Check error-code doc | `pnpm docs:error-codes --check` | `docs/ERROR-CODES.md` 与 `@taizan/contracts` 同步（T4-4） |

`checkout` 用 `fetch-depth: 0`：`check-changeset.mjs` 要算 `merge-base origin/<base> HEAD`，
浅克隆算不出来。

### `unit` —— build + 全量单测

```bash
pnpm -F @taizan/api prisma:generate   # 少了这步，单测会在 import 期报「找不到 @prisma/client」
pnpm build                            # turbo run build：全部 packages + 四个前端 app
pnpm test                             # turbo run test：全部包与 apps 的单测（含 test/arch）
```

**任务分解里列的 `web-build` 已经并进这个 job**：`pnpm build` 就是 `turbo run build`，
它本来就会跑到 `apps/{admin,platform,site,client}`。单开一个 job 等于把同一份 turbo 图跑两遍，
只为了在 UI 上多一个绿勾。前端构建真变慢（>2 分钟）的那天再拆，届时拆的理由是并行度。

缓存两层：pnpm store（`setup-node` 的 `cache: pnpm`）+ turbo 本地任务缓存
（`actions/cache` 缓存 `.turbo` 与 `node_modules/.cache/turbo`，key 带 sha、restore-keys 退到
分支和全局）。

### `arch` —— 蓝图 §8 的 16 条 + 「守卫真的会红」的证明

```bash
pnpm test:arch     # 16 条架构约束，输出按编号
pnpm check:arch    # 注入 4 类违规，验证对应 spec 会红
```

两条缺一不可，理由见 §3。

### `api-e2e` —— 真 MySQL + Redis

CI 用 `services:` 起 `mysql:8.0` + `redis:7`。本地用 compose：

```bash
pnpm dev:infra                        # mysql 3307 / redis 6380（刻意避开 3306/6379）
pnpm -F @taizan/api prisma:deploy     # migrate deploy，不是 dev
pnpm -F @taizan/api seed              # 幂等：权限点、菜单、通知模板、平台超管
pnpm test:e2e                         # = pnpm -F @taizan/api test:e2e
```

env 取值以 `apps/api/.env.example` 为准；CI 里显式列在 job 的 `env:` 下。关键几个：

- `BILLING_ENFORCE=false` —— 要测闸门的用例自己重建一个 `true` 的 app
  （见 `rbac-billing.e2e-spec.ts` 文件头：模块在**求值时**读 env，测试文件里改已经晚了）；
- `PAY_FAKE_ENABLED=true` —— `plan-order` 的兑现链路要靠带真 HMAC 的假回调走完；
- `REDIS_URL` 用 **3 号库**，见下面 §2。

### `migrate-check` —— migrations 与 schema 没有漂开

```bash
pnpm -F @taizan/api taizan:schema-check       # 00-base/ 与当前装着的 @taizan/prisma-base 一致
cd apps/api && pnpm exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema \
  --shadow-database-url "$SHADOW_DATABASE_URL" \
  --exit-code
```

`--exit-code` 的语义：0 = 没差异，2 = 有差异（step 红）。有差异 = 有人改了 schema 却没生成迁移。
这个漏洞在本地是看不见的——本地开发库是 `migrate dev` 直接推上去的，跑起来一切正常，
只有部署那天才会发现线上少了一列。

`taizan:schema-check` 与架构 spec 15 互补：spec 15 守「本地片段与 `base.lock.json` 一致」，
它守「本地片段与当前装着的框架版本一致」。升级了框架却忘了 `schema-sync`，只有后者会红。

---

## 2. e2e 的 Redis 库序号约定（**别用 0 号库**）

`apps/api` 的 e2e 会真的起 BullMQ worker。`rbac-billing.e2e-spec.ts` 里有一条用例入队一条
`goods.sync` 然后等着自己消费掉它——**如果同一台机器上还有别的 API 进程连着同一个 Redis 库，
那条任务会被它抢走**，用例超时红掉，看起来像「队列坏了」。这类假红最贵的地方在于它是间歇的：
本地 `pnpm dev` 没开的时候一切正常。

所以约定：**e2e 固定用 3 号库**。

这件事已经做成默认，不依赖谁记得传 env。`apps/api/vitest.e2e.config.ts` 在加载时：

- `REDIS_URL` 没设、或设了但指向 0 号库 → 改写成 3 号库（**只动库序号，主机/端口/密码原样保留**）；
- `REDIS_URL` 已指向非 0 库 → 原样尊重，一个字都不改；
- 想换别的库：`E2E_REDIS_DB=7`。

每次跑都会打一行说明，排查队列类假红时第一件事就是看它：

```
[e2e] Redis 库序号隔离：127.0.0.1:6380 的 0 号库 → 3 号库。（0 号库是 dev 进程的默认落点，
共用会被抢走 goods.sync 队列任务导致假红；要换库传 E2E_REDIS_DB=<n>，要完全自定义传一个非 0 库的 REDIS_URL。）
```

本地三种跑法都对：

```bash
pnpm test:e2e                                             # 自动 0 → 3
REDIS_URL=redis://127.0.0.1:6380/3 pnpm test:e2e          # 显式，等价
E2E_REDIS_DB=7 pnpm test:e2e                              # 换一个库，跟别人的 e2e 也错开
```

CI 的 `api-e2e` job 里 `REDIS_URL: redis://127.0.0.1:6379/3` 是显式写出来的——
config 里那层改写照样生效，写出来只是为了让日志里一眼看得见连的是哪个库。

---

## 3. `pnpm check:arch`：故意违规，证明守卫会红

`pnpm test:arch` 全绿只能说明「现在没有违规」，说明不了「有违规时会被抓住」。这两件事之间
差着一个正则：扫描器的正则一旦失效，它会安静地扫出零违规，而套件依然全绿。各 spec 内部的
哨兵（`SENTINEL_SOURCE`）守的是这一层，但哨兵喂的是**手写字符串**——「从真实文件到判定函数」
那条链路（目录遍历、路径过滤、白名单加载）它一步都没走。

`scripts/check-arch.ts` 换一种证明方式：把 `apps/api` 复制一份到 `apps/api/.arch-probe/api`
（放在 `apps/api` 里面是为了让 `node_modules` 解析自动通，不用造符号链接），往副本里注入四类
真实违规，看对应的 spec 红不红。跑完自动删副本；`--keep` 可以留着手工复现。

三重保险，缺一个这个脚本就会给出错误结论：

1. **基线**：干净副本上那四条 spec 必须全绿（副本坏了的话，四类注入会全部「通过」）；
2. **退出码非零**；
3. **失败信息里必须出现预期字样**（`ArchProbeLeak` / `arch-probe.controller.ts` / `Decimal` …）
   ——红得不对，等于没红。

实际输出：

```
── check-arch：往真实项目副本里注入违规，验证架构守卫会红 ──

副本目录：D:\project\taizan-saas\apps\api\.arch-probe\api

[0/4] 基线：干净副本上这四条 spec 必须全绿
      ✓ test/arch/tenant-models.spec.ts
      ✓ test/arch/guard-default-deny.spec.ts
      ✓ test/arch/index.spec.ts
      ✓ test/arch/cluster-safe.spec.ts

[1/4] ① 漏登记租户表：一张带 tenantId 的新表没进 TENANT_MODELS
      期望被 spec 1（test/arch/tenant-models.spec.ts）拦下
      ✓ 被拦下：spec 1：租户模型注册表与 schema 双向比对 > schema 里带 tenantId 的 model 全部在注册表里

[2/4] ② 新控制器无守卫：既没有 @Auth() 也没有 @Public()
      期望被 spec 5（test/arch/guard-default-deny.spec.ts）拦下
      ✓ 被拦下：spec 5：默认拒绝 + 公开路由必须限流 > 三个命名空间的控制器都声明了身份（@Auth 或 @Public，二选一）

[3/4] ③ 金额用 Decimal：schema 里加一个 Decimal 金额列
      期望被 spec 9（test/arch/index.spec.ts）拦下
      ✓ 被拦下：spec 09 · 金额列 > 禁用 Decimal

[4/4] ④ 裸 setInterval：绕过 @LeaderCron 的进程内调度
      期望被 spec 12（test/arch/cluster-safe.spec.ts）拦下
      ✓ 被拦下：spec 12：集群安全（多实例下不重复执行） > 零违规

── 结论 ──
① 拦下  spec 01  test/arch/tenant-models.spec.ts
② 拦下  spec 05  test/arch/guard-default-deny.spec.ts
③ 拦下  spec 09  test/arch/index.spec.ts
④ 拦下  spec 12  test/arch/cluster-safe.spec.ts

4 / 4 类违规全部被拦下。守卫有效。
```

注入的形状有两个细节是刻意的：

- 违规 ① 是**追加到已有的 `10-goods.prisma`**，不是新建一个 `.prisma` 文件——spec 1 里有一条
  「扫到的片段数必须是 10」的断言，新建文件会先撞上那一条，红的原因就变了；
- 违规 ③ 那张表**不带 `tenantId`**——带上会顺带惊动 spec 1，两条一起红就分不清是谁拦下的。

---

## 4. 蓝图 §8 的 16 条：落地状态

`pnpm test:arch` 跑 `apps/api/test/arch/**`，16 个文件 180 条断言，约 3 秒。
`apps/api/test/arch/index.spec.ts` 是这 16 条的**总目录**——它自己不重跑判定，
它守的是「有人把某一份 spec 删了 / 掏空了 / 换了内容，套件依然全绿」。

**16 条全部落地，0 条待补。** 三种形态：

| # | 约束 | 落在哪 |
|---|---|---|
| 1 | `TENANT_MODELS` ↔ schema 双向比对 | `test/arch/tenant-models.spec.ts` |
| 2 | 隔离决策函数的行为用例（≥25 条） | `packages/tenant-scope/src/plan.spec.ts`（71 条）；`index.spec.ts` 里有 6 条冒烟 + 条数下限断言 |
| 3 | `prisma.raw` 逃生口允许清单 | `test/arch/raw-usage.spec.ts` |
| 4 | 业务模块禁止手写 `tenantId` 过滤 | `test/arch/no-manual-tenant-filter.spec.ts` |
| 5 | 默认拒绝 + 公开路由必须限流 | `test/arch/guard-default-deny.spec.ts` |
| 6 | 权限点注册表双向对账 | `test/arch/permission-registry.spec.ts` |
| 7 | 菜单 `componentKey` ↔ 前端映射 | `test/arch/menu-route-map.spec.ts` |
| 8 | 续费白名单 ↔ 控制器前缀 ↔ 功能项 | `test/arch/billing-routes.spec.ts` |
| 9 | 金额列：禁 `Decimal`、必须 `*Cents Int` | **`index.spec.ts`**（判定用 `@taizan/prisma-base` 的 `lintSchemaConventions`） |
| 10 | 主键 / 枚举 / 索引 / 软删唯一键 | **`index.spec.ts`**（同上） |
| 11 | 加密列三处对账 | **`index.spec.ts`**（判定用 `@taizan/crypto` 的 `verifyEncryptedColumns` + `planRotation`） |
| 12 | 集群安全（禁裸 `setInterval` / 裸 `@Cron`） | `test/arch/cluster-safe.spec.ts` |
| 13 | 禁止直接读 `x-forwarded-for` / `req.ip` | `test/arch/ip-source.spec.ts` |
| 14 | 建租户只有 `@taizan/provision` 一条路 | `test/arch/provision-single-path.spec.ts` |
| 15 | `00-base/` 的 sha256 与 `base.lock.json` 一致 | `test/arch/base-schema-integrity.spec.ts` |
| 16 | `TenantMiddleware` 的 `forRoutes`/`exclude` | `test/arch/tenant-middleware.spec.ts` |

编号外还有三条同样跑在 `test/arch/` 里的约束，登记在 `index.spec.ts` 的 `EXTRA_SPECS`：
`guard-order.spec.ts`（守卫链顺序，蓝图 §4.3）、`plan-order-fulfill.spec.ts`（T1-5：把钱变成权益
的代码只能有一份）与 `response-shape.spec.ts`（蓝图 §9「knowledge CLAUDE.md 8 条不变量」第 8 条
点名的「统一响应包」spec：控制器不许 `res.json(`/`res.send(` 绕过信封、`BizException` 首参不许
是裸数字字面量——不在 §8 的 16 条编号内，见 `docs/SECURITY-INVARIANTS.md` K8）。
新增任何 `test/arch/*.spec.ts` 都必须登记进这两张表之一，否则
`index.spec.ts` 会红——「加了 spec 但没人知道它守哪一条」是另一种形式的漂移。

### 9 / 10 / 11 为什么写在 `index.spec.ts` 里而不是各给一个文件

蓝图给它们起了名（`money-field` / `enum-and-key` / `credential-registry`），但判定逻辑
**已经存在于框架包里**，且已经在包自己的单测里跑过一遍——`packages/prisma-base/src/schema.spec.ts`
用同样的函数扫框架的 8 个基础片段。缺的只是「用同一套规则扫**这个应用的全部 schema**
（含 `10-business/`）」这一次调用。为此新开三个文件，每个文件里只有一句
`lintSchemaConventions(...)`，收益是文件名好看，代价是三处 `ENUM_EXEMPTIONS` 要各自维护。
所以放在一起。

### 已知未覆盖点

- **spec 7 目前比不到真前端**：比对对象是服务端的 `src/registry/component-keys.ts`，
  不是 `apps/admin/src/routes/component-map.ts`（见该 spec 文件头的 `TODO(T3-2)`）。
  它现在守得住「新增菜单必须同时登记 componentKey」与「菜单权限点必须存在」，
  守不住「前端真的有这个组件」。
- **验收里的 `@taizan/*` 不是从 registry 装的**（见 §5「已知未覆盖点」）。
- **`check:arch` 只证明 4 类**，不是 16 条都做了注入证明。这 4 类是任务分解 T4-2 点名的
  验收条目，也是历史上真出过事故的 4 类。其余 12 条目前只靠各自 spec 内部的哨兵。
- **CI 没在 GitHub 上真跑过**：本仓库当前没有 commit 也没有远端。三个 workflow 用
  `@action-validator/cli` 校验通过（并用一份故意写坏的 workflow 验过 validator 本身会红），
  各 job 的命令逐条在本地跑过，但 `services:` 容器编排、缓存命中率、总时长这三项要等
  第一次真跑才能确认。

---

## 5. 验收判据（T4-5）：`pnpm acceptance`

前面四节讲的都是「有没有坏」。这一节讲的是**「能不能交付」**——两件不同的事。

框架真正的交付形态不是这个仓库，是 `create-taizan-saas` 吐出来的那个项目。仓库里全绿而
生成出来的项目跑不起来是完全可能的：模板里少写一个依赖、`.env.example` 少一行、架构 spec 里
残留一句 `../../../../packages/xxx` 的相对路径（那种路径在生成项目里必然是错的，因为那边的
框架是当依赖装进来的）。所以判据只有一条：

```bash
pnpm dev:infra      # MySQL 3307 / Redis 6380
pnpm acceptance     # 蓝图 §6 的 9 条，全绿才算可交付
```

**任一条失败即视为框架未完成，不允许放宽。**

### 这一条命令做了什么

| 步 | 命令 | 守什么 |
|---|---|---|
| 1 | TCP 探 MySQL / Redis | 缺依赖库时给的是「跑 `pnpm dev:infra`」，不是一屏连接超时 |
| 2 | `pnpm build:templates:check` | 模板与当前 `apps/` 的 sha256 对账。改了框架却忘了同步模板，这里红 |
| 3 | `pnpm --filter "./packages/*" build` + `pnpm -F create-taizan-saas build` | `packages/*` 得先有 `dist`，否则 `pnpm pack` 出来的 tarball 是空壳 |
| 4 | `pnpm -F create-taizan-saas test:e2e` | 9 条断言本体 |

第 2 步排在 build **之前**不是随手排的：`apps/site` 的构建会跑 `scripts/generate-seo.ts`，
把「今天的日期」写进受版本管理的 `public/sitemap.xml` 的 `<lastmod>`。先 build 再对账，
只要模板快照不是当天做的就必红，而红的原因跟这次改了什么毫无关系（T4-5 实测踩到）。
第 3 步也因此**不跑根 `pnpm build`**——验收用不上本仓库 `apps/` 的产物（生成项目会在临时
目录里自己 build 一遍 api），本仓库 `apps/` 的全量构建归 `ci.yml` 的 `unit` job。

第 4 步（`tools/create-taizan-saas/e2e/acceptance.spec.ts`）从**空目录**起：

生成器 `--preset=full --yes` → 写 `.env`（随机库名 `acc_<hex>`、Redis **12 号库**，
跑之前 `flushdb`、三套随机 JWT 密钥、`BILLING_ENFORCE=true`、`PAY_FAKE_ENABLED=true`）→
`prisma migrate dev --name init` → `seed` → `tsup` 构建 api → `node dist/main.js`
起子进程（随机端口）→ 逐条断言 → 关进程、删库、删目录。

全程纯 HTTP：没有 `Test.createTestingModule`，没有 `overrideProvider`，也不写一行业务代码
（9 条全部走生成项目自带的 `example-goods` 模块与框架接口）。

### 9 条各自断言什么

| # | 断言 | 关键判据 |
|---|---|---|
| ① | 平台超管登录 | `POST /api/platform/auth/login` → token 的 `kind` 是 `platform` |
| ② | 建租户 + 选套餐 | `POST /api/platform/tenants` → `planId` 与 `planExpireAt` 都落库，店主一并建出 |
| ③ | 商家店主登录 | 一号多店时先 `needChooseShop`（不发 token），指定门店后 `token.tenantId` = 当前店 |
| ④ | 切换门店（重签 token） | `POST /api/admin/auth/switch` → 新 token 的 `tenantId` 变了、`accountId` 没变；**旧 token 仍指向原店**（蓝图附录第 5 条决策） |
| ⑤ | C 端会员登录 | `POST /api/client/auth/login-dev` + `X-Tenant-Slug` → `kind` 是 `member`，读得到在架商品；无租户线索的 C 端请求被挡 |
| ⑥ | 示例 CRUD | 增 / 列表 / 详情 / 改 / 删全通，软删后读路径立刻看不到 |
| ⑦ | 跨租户 | A 的 token 对 B 的资源读/改/删一律 `1240300`；列表与伪造 `X-Tenant-Id` 也越不过去；B 自己读得到 |
| ⑧ | 套餐到期 | `planExpireAt` 改成昨天后：后台写 `1440301`（错误体带 `renewalPath`）、后台读仍 `0`、`/api/admin/billing` 与 `/api/admin/auth` **仍可写**、C 端 `1440302` |
| ⑨ | 续期 | Fake 回调（HMAC 签名，`/api/public/pay/wechat/notify`）→ 租户 `planExpireAt` 推到未来、后台恢复可写、`AuditLog` 一条 `plan-order.fulfill`；**重复推送不重复兑现** |

⑧ 的三段缺一不可。只断言「到期后写不了」而不断言「续费路径仍然可写」，守不住
「到期 → 只读 → 续不了费 → 永远到期」那个死循环（knowledge 上真出过）。

### 与 `pnpm create:demo`（T4-1）的分工

两个都会真生成项目、真装依赖，别的不重叠：

| | `create:demo` | `acceptance` |
|---|---|---|
| 生成几个项目 | 两个（`full` + `api-only`） | 一个（`full`） |
| 编译什么 | 七个端全 build | 只 build api（9 条断言全打在 api 上） |
| 跑什么测试 | 生成项目自己的 `pnpm test`（单测 + 架构约束 16 条）与 `test:e2e` | 生成项目**跑起来之后**的 9 条 HTTP 断言 |
| `BILLING_ENFORCE` | `false` | **`true`**（⑧ ⑨ 的前提） |
| Redis 库 | 10 | 12 |
| 回答的问题 | 「生成出来的东西能编译、单测能过吗」 | 「它是不是一个能用的 SaaS」 |

### CI 里怎么跑

`.github/workflows/generator-e2e.yml`：`services:` 起 `mysql:8.0` + `redis:7`，
然后一行 `pnpm acceptance`。判据不在 workflow 里重写一遍——CI 与本地判据分叉是最贵的
一类漂移（线上红了没人能在本地复现）。触发：每天 UTC 19:00 定时 +
`tools/create-taizan-saas/**` / `packages/**` 变动的 PR + 手动。

不放进每个 PR 是因为它一趟十几分钟；而它坏掉的方式通常是「上游包发了个新版本」，
与当天的提交无关——那正是定时跑比 PR 触发更有价值的地方。

MySQL 用 `root`：验收要建库、删库，`prisma migrate dev` 还要建一个 shadow database，
这三件都是判据的一部分。

### 常用变体

```bash
pnpm acceptance --keep          # 留现场：目录、库、还在监听的 api 进程都不动，地址打在最后
pnpm acceptance --skip-build    # 上一次 build 还热着时跳过第 3 步
pnpm -F create-taizan-saas test:e2e    # 只跑第 4 步
ACC_DB_PORT=3306 ACC_REDIS_DB=7 pnpm acceptance   # 换库
```

`--keep` 之后 api 进程是**活的**（`detached` + `unref`），可以直接
`curl <打印出来的地址>/health`。收工时按提示 kill 进程、删目录与库。

### 为什么是 `prisma migrate dev --name init`

模板里 `apps/api/prisma/migrations/` 只有 `migration_lock.toml`，一条迁移都没有——迁移 SQL
是「某一次 schema 的差异」，而生成器会裁掉示例模块、换业务域名字、切数据库厂商，预生成的
SQL 对其中任何一种组合都是错的。于是 `migrate deploy` 跑完是个空库（seed 立刻炸），
`db push` 能建表但绕开了迁移引擎（验不到「这份 schema 能生成合法 SQL」）。
`migrate dev --name init` 走真实引擎，含 shadow database 校验。

它写的是**生成项目**里的 `<临时目录>/acc-demo/apps/api/prisma/migrations/`，跑完整个目录删掉；
仓库里的 `templates/` 全程只被读。第 3 步的 `build:templates:check` 顺带守着这一点。

### 已知未覆盖点

- **`@taizan/*` 不是从 registry 装的**。包还没发布，验收用 `pnpm pack` + `file:<tgz>` 覆写
  （`e2e/harness.ts`）。这条路验得到依赖清单完整性、`files` 有没有漏打 `dist`、以及
  「依赖从生成项目这边解析」（`link:` 会让 `@nestjs/core` 在进程里出现两份，Nest 的 DI
  按类比对 token，报一句与生成器毫无关系的「can't resolve dependencies of ... (?)」）。
  验不到的是 registry 上的版本号解析与 `prepublishOnly` 钩子——那两件由 `release.yml` 管。
  包发布之后把 harness 里的 overrides 去掉即可，判据一个字不用改。
- **只跑 `--preset=full` + MySQL**。`api-only` 的裁剪由 `create:demo` 覆盖；
  PostgreSQL 分支目前没有任何端到端覆盖。
- **前端四个端只被装、没被跑**。9 条断言全打在 api 进程上，`apps/admin` 的页面能不能渲染
  不在这 9 条里（架构 spec 7 也只比到服务端注册表，见 §4）。
- **`--keep` 留下的进程没人回收**。忘了 kill 就一直占着那个随机端口和那个临时库。
- **9 条之间有先后依赖**（② 建的租户是 ④ 和 ⑦ 的对象、⑧ 下的单是 ⑨ 付的那笔），
  所以 `bail: 1`。不能单独重跑第 ⑦ 条。
