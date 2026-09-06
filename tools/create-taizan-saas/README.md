# create-taizan-saas

taizan-saas 的**项目生成器**。它产出的那个项目才是框架的交付形态——别人拿到手的不是
`taizan-saas` 这个仓库，是这里吐出来的目录。

```bash
pnpm create taizan-saas my-shop                       # 交互式，问 8 个问题
pnpm create taizan-saas my-shop --preset=full --yes   # 非交互（CI / 验收用）
```

## 命令行参数

| 参数 | 作用 |
|---|---|
| `<项目名>` | 目录名、包名、pm2 进程名的来源；`--yes` 模式下必填 |
| `--preset=<名字>` | 端组合：`full` / `api-only` / `api+admin` / `api+admin+platform` / `web` |
| `--yes`, `-y` | 不问问题，全用默认值（配合 `--preset`） |
| `--from=<路径>` | 从本地框架仓库取模板，而不是本包随附的 `templates/`。开发生成器本身时用 |
| `--skip-install` | 生成完不跑 `pnpm install` |
| `--skip-git` | 生成完不跑 `git init` |
| `--force` | 目标目录非空时也继续 |

生成之后自动做四件事：`git init` → `pnpm install` → `pnpm taizan:schema-sync` →
`pnpm prisma:generate`，然后打印验收清单。**这四步失败只警告不中断**——文件已经全部落盘，
装不上依赖的原因（registry、代理、包还没发布）多半在生成器管不着的地方，把已生成的目录
删掉重来是最糟的选择。

## 八个问题各自影响什么

见蓝图 §6 的表。默认答案（`--yes`）：scope `@<项目名>`、业务域「商品 / goods」、
MySQL 8、微信支付、保留示例模块。

## 模板是怎么来的

`templates/` **不是手写的**，是 `scripts/build-templates.ts` 从仓库 `apps/**` 快照出来的，
带一份 `manifest.json`（每个文件的 sha256）。

```bash
pnpm build:templates          # 重新快照
pnpm build:templates:check    # 对账：模板与当前 apps/ 是否一致（CI 与验收都会跑）
```

改了 `apps/`（框架侧）而忘了同步模板，生成出来的项目就会停在上一个版本上——
`build:templates:check` 守的就是这条。

## 三层测试，一层比一层贵

| 命令 | 跑什么 | 大约耗时 |
|---|---|---|
| `pnpm test` | `test/**`：渲染、裁剪、manifest 一致性。**不装依赖、不联网** | 秒级 |
| `pnpm create:demo`（仓库根） | 真的生成 full + api-only 两个项目，真的装依赖、编译、跑单测与架构约束 | 十几分钟 |
| `pnpm acceptance`（仓库根） | 下面这一节 | 十几分钟 |

---

## 验收判据（蓝图 §6 的 9 条）

**框架是否可交付，只看这 9 条。任一条失败即视为未完成，不允许放宽。**

判据落在 `e2e/acceptance.spec.ts`，一条命令跑完：

```bash
pnpm dev:infra          # 先起 MySQL 3307 / Redis 6380
pnpm acceptance         # 仓库根
```

它做的事：**从空目录起**调本仓库的生成器产出一个 `--preset=full` 项目 → 写 `.env`
（随机库名 `acc_<hex>`、Redis 12 号库、随机三套 JWT 密钥、`BILLING_ENFORCE=true`、
`PAY_FAKE_ENABLED=true`）→ `prisma migrate dev --name init` → `seed` → `tsup` 构建 api →
`node dist/main.js` 起子进程（随机端口）→ 对着这个进程逐条断言 → 关进程、删库、删目录。

**不写一行业务代码**：9 条全部走生成项目自带的 `example-goods` 模块与框架接口。

| # | 断言 |
|---|---|
| ① | 平台超管登录：`POST /api/platform/auth/login` 拿到 platform kind 的 token |
| ② | 建租户 + 选套餐：平台侧建出租户 B，落库并带上套餐与到期时间 |
| ③ | 商家店主登录：seed 出来的租户 A 店主登录，token 里的 `tenantId` 就是当前店 |
| ④ | 切换门店：`POST /api/admin/auth/switch` **重签**一张新 token，`tenantId` 换成目标店而 `accountId` 不变；旧 token 仍指向原店（蓝图附录第 5 条决策）|
| ⑤ | C 端会员登录：走 dev 登录通道拿到 member kind 的 token |
| ⑥ | 示例 CRUD：`example-goods` 的增 / 查列表 / 查详情 / 改 / 删全通 |
| ⑦ | 跨租户：租户 A 的 token 访问租户 B 的资源，返回 `1240300` |
| ⑧ | 套餐到期：`planExpireAt` 改成昨天后，后台写接口 `1440301`、`/api/admin/billing` **仍可写**、C 端 `1440302` |
| ⑨ | 续期：下一笔套餐订单走 Fake 支付回调，租户自动续期且 `AuditLog` 有记录 |

⑧ 的三段缺一不可：只断言「到期后写不了」而不断言「续费路径仍然可写」，就守不住
「到期 → 只读 → 续不了费 → 永远到期」那个死循环（knowledge 上真出过）。

### 单独跑 / 留现场

```bash
pnpm -F create-taizan-saas test:e2e     # 只跑第 4 步（跳过模板对账与 build）
pnpm acceptance --skip-build            # 上一次 build 还热着的时候（跳过第 3 步）
pnpm acceptance --keep                  # 跑完保留临时目录 + 临时库 + 打印 api 地址
```

`--keep` 之后 api 进程**还活着**（`detached` + `unref`，所以 vitest 照样能退出），
目录与库也都在。跑完最后会打出地址：

```bash
curl http://127.0.0.1:<端口>/health
# {"status":"up","checks":{"db":"up","redis":"up"},...}
```

收工时按提示 kill 掉进程，再删临时目录与那个 `acc_<hex>` 库——`--keep` 不会替你回收。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ACC_DB_HOST` / `ACC_DB_PORT` | `127.0.0.1` / `3307` | 验收用的 MySQL |
| `ACC_DB_USER` / `ACC_DB_PASS` | `root` / `taizan_dev_root` | 需要建库/删库权限（`migrate dev` 还要 shadow db） |
| `ACC_REDIS_HOST` / `ACC_REDIS_PORT` | `127.0.0.1` / `6380` | |
| `ACC_REDIS_DB` | `12` | 独占一个库，跑之前会 `flushdb`。别用 0（dev）/ 3（api e2e）/ 5（CI generator-e2e）/ 10（create:demo） |
| `ACCEPTANCE_KEEP` | — | `=1` 等价于 `--keep` |

### 为什么是 `migrate dev --name init`

模板里 `apps/api/prisma/migrations/` 只有 `migration_lock.toml`，一条迁移都没有——迁移 SQL
是「某一次 schema 的差异」，而生成器会裁掉示例模块、换业务域名字、切数据库厂商，预生成的
SQL 对其中任何一种组合都是错的。于是 `migrate deploy` 跑完是个空库（seed 立刻炸），
`db push` 能建表但绕开了迁移引擎。`migrate dev --name init` 按当前 schema 生成第一条迁移
并应用，走的是真实引擎（含 shadow database 校验）。

它写的是**生成项目**里的 `<临时目录>/acc-demo/apps/api/prisma/migrations/`，跑完整个目录删掉；
本仓库的 `templates/` 全程只被读。`pnpm acceptance` 的第 2 步（`build:templates:check`，
sha256 对账）就守着这一点，万一哪天有人把这条路写歪了，那一步会红。
