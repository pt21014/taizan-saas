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

## 0. 为什么每个 job 都要先 build 包

这是仓库第一次真跑 GitHub Actions（run 34008416754）暴露出来的坑，四个 job 全红：

| job | 报错 | 直接原因 |
|---|---|---|
| `quality` | typecheck：`Cannot find module '@taizan/billing-rules'` | 只装了依赖，没编译 workspace 包 |
| `arch` | `Failed to resolve entry for package "@taizan/prisma-base"` | 同上 |
| `migrate-check` | `taizan-schema-sync` 这个 bin 指向不存在的 `dist/cli/sync.js` | 同上 |
| `api-e2e` | seed 找不到 `@taizan/contracts/dist/index.js` | 同上 |

根因都是同一个：`packages/*` 的 `package.json` 里 `main`/`exports`/`bin` 指向的是
`dist/**`，而 `dist/` 是 `tsup` 编译出来的产物，不在 git 里（也不应该在）。本地开发机上
`pnpm install` 之后 `dist/` 常年都在——谁会没事去删 `packages/*/dist`——这个「其实依赖一次
构建」的事实因此被本地环境悄悄掩盖了很久。GitHub Actions 的每个 job 都是一次全新
`actions/checkout`，`pnpm install --frozen-lockfile` 只做符号链接和下载依赖，不会触发任何
包的 `build`；`quality` / `arch` / `migrate-check` / `api-e2e` 这四个 job 在 install 之后
直接 `import`/`require` 或执行 workspace 包的编译产物，第一次在纯净环境里跑就必然全红。

`unit` job 恰好没有这个问题——它本来就要跑 `pnpm build`（全量 `turbo run build`，含四个
前端 app）再跑 `pnpm test`，build 已经在那一步做了。

修法：四个受影响的 job 都在 `pnpm install` 之后、真正用到 workspace 包之前，加一步

```bash
pnpm build --filter './packages/*' --filter './tools/*'
```

只构建 `packages/*` 与 `tools/*`，不含 `apps/*`——这四个 job 谁都用不到四个前端 app 的
构建产物，图省事跑全量 `pnpm build` 只会白白多等前端编译的那几分钟。`unit` job 已经在跑
全量 `pnpm build`，不重复加这一步。

代价是四个 job 各自要多跑一次同样的包构建。用 `actions/cache` 缓存 `.turbo` 与
`node_modules/.cache/turbo`（与 `unit` job 同一段配置、同一个 cache key）来对冲：
同一次 push 里五个 job 并行跑、彼此看不到对方本次写入的缓存，但只要有过一次成功的构建
（哪怕是上一次 push 留下的），turbo 的内容寻址缓存就能让后续这一步在几秒内跳过真正的编译，
只在包源码真的变了的时候才重新构建那个包。pnpm store 的缓存则由每个 job `setup-node` 步骤
里已有的 `cache: pnpm` 负责，不需要额外配置。

## 0.1 build 之外，还有三样「本地有、干净 checkout 没有」

修完 §0 之后再跑（run 34009292273），`unit` 和 `api-e2e` 转绿，另外三个 job 换了个姿势继续红。
根因是同一类，只是这一次缺的不是 `dist/`：

| job | 报错 | 缺的是什么 |
|---|---|---|
| `quality` | `Module '"@prisma/client"' has no exported member 'Announcement'`（一屏 TS2305 / TS2694 / TS7006） | **Prisma client 没生成** |
| `arch` | `sh: 1: tsx: not found` | **根 `package.json` 没有 `tsx`** |
| `migrate-check` | `sh: 1: taizan-schema-sync: not found` / `spawn ENOENT` | **workspace 包的 bin 软链没建起来** |

### ① Prisma client 是产物，不进仓库

`apps/api` 的 service 层大量 `import type { Announcement, Prisma } from '@prisma/client'`。
这些名字来自 `prisma generate` 写进 `node_modules/.prisma/client` 的产物；没跑 generate 时
`@prisma/client` 只是个运行时壳子，`tsc` 会把每一个模型名报成 TS2305，顺带把所有依赖推断的
回调参数报成 TS7006——看起来像「代码坏了」，实际只是少跑了一步。

本地 `node_modules` 里 `.prisma/client` 常年都在，所以这个依赖一直隐身。`unit` job 在 §0 那轮
已经踩过并加了这一步，`quality` 漏了。修法：凡是 typecheck 或执行 `apps/api` 代码的 job，
在 `build packages` 之后统一加

```bash
pnpm -F @taizan/api prisma:generate
```

`quality` / `arch` / `migrate-check` 三个 job 都加上了（`unit` / `api-e2e` 本来就有）。
这一步不连数据库：`apps/api/prisma.config.ts` 在场时 Prisma 会打印
`Prisma config detected, skipping environment variable loading.`，`DATABASE_URL` 没设也能 generate。

### ② 根 script 用了 `tsx`，根就必须依赖 `tsx`

根 `package.json` 的 `check:arch` 和 `check:peer-deps` 都是 `tsx scripts/*.ts` 开头，但 `tsx`
当时只是 `apps/api` 的 devDependency。pnpm 只把**直接依赖**的 bin 放进 `<pkg>/node_modules/.bin`，
所以干净装完之后根本没有 `node_modules/.bin/tsx`——CI 上 `pnpm check:arch` 第一行就
`sh: 1: tsx: not found`。

本地一直没事，是因为根 `node_modules/.bin/tsx` 是历史某次安装留下的残留（同一批残留还有
`vite` / `sass` / `terser` / `jiti`，它们同样不是根的直接依赖）。**这类残留是本地环境最容易
骗人的地方：它让一个缺失的依赖看起来像装好了。**

修法：把 `tsx` 加进根 `devDependencies`（`^4.19.2`，与 `apps/api` 同一条 specifier，pnpm 解析到
同一个 4.23.13，`pnpm-lock.yaml` 只多三行）。这一条同时修好 `arch` 的 `check:arch` 和
`quality` 里排在 typecheck 后面、当时还没轮到的 `check:peer-deps`。

### ③ workspace 包的 bin 软链只在 install 那一刻建，过期不补

`apps/api` 的 `taizan:schema-check` 走的是 `apps/api/node_modules/.bin/taizan-schema-sync`。
这个 shim 是 pnpm 照 `@taizan/prisma-base` 的 `bin` 字段建的，而**建的时机是 `pnpm install`**。
全新 checkout 上 install 必然跑在 build 之前，那一刻 `packages/prisma-base/dist/cli/sync.js`
还不存在，于是 install 日志里刷出一批

```
[WARN] Failed to create bin at .../apps/api/node_modules/.bin/taizan-schema-sync.
       ENOENT: no such file or directory, open '.../packages/prisma-base/dist/cli/sync.js'
```

一共五个 bin 建失败（`taizan-schema-sync` / `taizan-verify-schema` / `taizan-rbac-sync` /
`taizan-env-example` / `taizan-rotate-key`），**而后面那步 build 不会回头补建**。
实测 pnpm 11 上二次 `pnpm install --frozen-lockfile`、乃至加 `--force`，只要 lockfile 与
node_modules 状态没变就是一句 `Already up to date`，bin 依然不在。

所以 CI 里不能走 `.bin`，直接跑编译产物：

```yaml
run: node packages/prisma-base/dist/cli/sync.js apps/api/prisma/schema --check
```

CLI 自己从 `process.argv[1]` 所在目录向上找包根来定位框架的 `schema/`，目标目录按 cwd 解析，
两者都跟有没有 bin 无关。本地开发机上 `dist/` 常年在、install 时链得上，
`pnpm -F @taizan/api taizan:schema-check` 照旧可用，两条命令跑的是同一个 `sync.js`。

> 顺带排除一个当时的怀疑：`base.lock.json` 的 sha256 **不会**被 CRLF/LF 影响。
> `packages/prisma-base/src/cli/sync.ts` 里的 `hashSchemaContent()` 先 `normalizeEol()`
> 把 `\r\n` / `\r` 归一成 `\n` 再算摘要，写文件时也只写 LF；`.gitattributes` 又钉了
> `* text=auto eol=lf`。Windows 生成、Linux 校验，两边算出来是同一个 hash。


## 0.2 第三轮：shadow database 与「快照过期」

第三次真跑（run 34010154658）`quality` / `arch` / `api-e2e` 转绿，剩下两个：

| job | 报错 | 根因 |
|---|---|---|
| `migrate-check` | `Error: P1003 Database taizan_shadow does not exist` | service 容器没建这个库 |
| `unit` | `build:templates --check` 报两个文件「内容漂移」 | **模板快照过期**，不是构建期改写 |

### ④ `migrate diff --shadow-database-url` 不会自己建库

`mysql:8.0` 镜像的 entrypoint 只认 `MYSQL_DATABASE` 这**一个**库名（这个 job 里是
`taizan_ci`）。第二个库没有任何声明式入口。而 `prisma migrate diff --shadow-database-url`
要的是一个**已经存在**、可以随便建表删表的空库——它会往里重放整个 migrations 历史再读回
结构，但**不会替你 `CREATE DATABASE`**，连不上就直接 P1003。

（`prisma migrate dev` 会自己建 shadow 库，`migrate diff` 不会。两条命令在这一点上不同，
容易按前者的经验想当然。）

修法：在 migrate diff 之前用 runner 自带的 `mysql` 客户端现建一个：

```yaml
- name: 建 shadow 库
  run: |
    mysql -h 127.0.0.1 -P 3306 -u root -p"$MYSQL_ROOT_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS taizan_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  env:
    MYSQL_ROOT_PASSWORD: taizan_ci_root
```

三个细节：

- **不走 `docker exec`**。service 容器的名字是 Actions 生成的随机串，得先 `docker ps` 去捞，
  多一层脆。`127.0.0.1:3306` 是 service 已经映射出来的端口，job 起来时 health-cmd 已经通过。
- **不加反引号**。`run: |` 是 bash，双引号串里的反引号会被当成命令替换；`taizan_shadow`
  不是保留字，本来也不需要引用标识符。
- **不用再 `GRANT`**。这个 job 的 `DATABASE_URL` / `SHADOW_DATABASE_URL` 都是 root
  （migrate diff 要 CREATE/DROP 权限），root 在 mysql 镜像里对所有库天生全权。

本地用 `pnpm dev:infra` 的 mysql（3307）验证过：建库前 `migrate diff` 就是那句 P1003，
建库后 `No difference detected.` 且退出 0。

### ⑤ 「内容漂移」这次不是构建期改写，是忘了重跑快照

前两次 `build:templates --check` 报漂移（`apps/site` 的 `sitemap.xml` 与 `tokens.css`）都是
**构建期产物混进了源码树**，修法是把它们移出 git、让 build 自己生成。这一次报的是

```
· 内容漂移：.prettierignore.hbs        ← .prettierignore
· 内容漂移：apps/site/vitest.config.ts ← apps/site/vitest.config.ts
```

看起来像同一类，其实不是。上一个 commit 改了这两个源文件（给 `.prettierignore` 加
`apps/site/src/styles/tokens.css`、给 site 的 vitest 加 `testTimeout`），**但没有重跑
`pnpm build:templates`**。快照落后于源文件，`--check` 就该红——这正是它存在的意义。

判据很干脆：干净克隆里跑完 `pnpm install → prisma:generate → pnpm build`（全量，含六个
app）之后 `git status --porcelain` **是空的**，没有任何受控文件被 build 改写；而
`build:templates --check` 在 build 之前就已经红了。构建期改写这个嫌疑可以排除。

修法就是脚本自己提示的那句：`pnpm build:templates` 重新快照，然后看一眼 diff
（只多了那两个源文件的改动 + manifest 里对应的两条 sha256，没有别的东西跟着变）。

**改了 `apps/**` / 根配置里被快照覆盖的文件，同一个 commit 里就要带上重新生成的
`templates/`。** 本地进 commit 前跑一次 `pnpm build:templates:check` 就能提前发现。

### ⑥ 让 `--check` 的失败信息在 CI 上看得见

上面那两个文件名，其实第一次 CI 红的时候是**看不到的**。`generator.spec.ts` 里那条用例用
`execFileSync(..., { stdio: 'pipe' })` 跑 `build-templates.ts --check`，失败时抛的 Error
只有一句 `Command failed: node ...`，漂移清单躺在 `error.stderr` 这个 Buffer 里，而 vitest
把它序列化成

```
Serialized Error: { status: 1, ..., stderr: '<Buffer(360) ...>' }
```

——只知道「有 360 字节」，不知道是哪个文件，只能本地重跑一遍才看得见。现在这条用例自己接住
异常，把子进程的 stderr/stdout 解成文本拼进错误信息（`e.message` 里已经有的那部分不重复拼），
CI 日志里直接就是那两行「内容漂移：xxx」。


---

## 1. 各 job 做什么 · 本地等价命令

### `quality` —— 静态检查与「文档/依赖是否同步」

| CI 步骤 | 本地等价 | 守什么 |
|---|---|---|
| Generate Prisma client | `pnpm -F @taizan/api prisma:generate` | 不是检查，是前置：typecheck 要 `.prisma/client` 的类型（§0.1 ①） |
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
                                              # CI 里等价地写成 node packages/prisma-base/dist/cli/sync.js
                                              # apps/api/prisma/schema --check（绕开 .bin，理由见 §0.1 ③）

# shadow 库要先存在——migrate diff 不会自己建（见 §0.2 ④）。本地 dev mysql 是 3307：
mysql -h 127.0.0.1 -P 3307 -u root -ptaizan_dev_root -e "CREATE DATABASE IF NOT EXISTS taizan_shadow;"
export SHADOW_DATABASE_URL="mysql://root:taizan_dev_root@127.0.0.1:3307/taizan_shadow"

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
- **CI 首跑（run 34008416754）四个 job 全红过**：`quality` / `arch` / `migrate-check` /
  `api-e2e` 都是「全新 checkout 没有先 build workspace 包，`dist/` 不存在」——本地一直有
  `dist` 所以从没暴露过，见 §0。已在这四个 job 里补上 `pnpm build --filter './packages/*'
  --filter './tools/*'`，并用 `actions/cache` 缓存 `.turbo`；`@action-validator/cli`
  校验两个 workflow 语法通过，四个 job 需要的命令也在本地逐条验证过，但 `services:`
  容器编排、跨 job 的缓存命中率、总时长这三项仍要等下一次真跑才能确认。

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
