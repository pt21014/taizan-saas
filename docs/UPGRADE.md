# 升级框架版本

面向**业务项目**（用 `create-taizan-saas` 生成、已经在跑的实际项目）。
框架自己的发布流程见 `docs/RELEASE.md`。

一句话版本：**升版本 → `schema-sync` → review diff → `migrate dev` → 跑全部 arch spec → 看 CHANGELOG 的三栏**。
下面把每一步为什么不能跳讲清楚。

---

## 0. 先读 CHANGELOG 的「变更影响面」三栏

每个 `@taizan/*` 包的 CHANGELOG 里，每条变更都带这张表（模板在 `docs/RELEASE.md` §4）：

| 是否需要动 schema | 是否需要动 env | 是否需要动接线 |
| --- | --- | --- |
| 是/否 + 具体哪个 prisma 片段字段 | 是/否 + 新增/废弃哪个环境变量 | 是/否 + 模块装配/守卫顺序/装饰器用法 |

**三栏全「否」的升级，跳过第 2–4 步，只跑第 5 步做回归。**
任何一栏是「是」，整套流程走一遍。

跨多个版本升级时，**每个中间版本的三栏都要读**——不能只看最新那条。
一个典型的坑：`1.2` 加了个字段、`1.4` 又把它改名了，只看 `1.4` 的话你会以为不用动 schema。

---

## 1. 升版本

```bash
# 单个包
pnpm update @taizan/nest-auth --latest

# 全部框架包（九个 nest-* 是 linked 组，版本号总是一致的）
pnpm update "@taizan/*" --latest

pnpm install
```

> 九个 `@taizan/nest-*` 用 changesets 的 `linked` 分组，**任何一个发新版，另外八个会同步到相同版本号**
> （即使没有代码变化，也会各带一条「随组同步」的 CHANGELOG）。这是发布粒度上的取舍：
> 换来的是你的 `package.json` 永远不会出现「nest-auth 要求 nest-core@^1.2 但装的是 1.4」这种
> peer 矩阵冲突。所以看到八个包一起跳版本、CHANGELOG 却是空的，属于正常。

升完先看一眼有没有 peer 警告：

```bash
pnpm install 2>&1 | grep -i "peer"
```

---

## 2. `pnpm taizan:schema-sync`

```bash
pnpm -F @taizan/api taizan:schema-sync
```

从新版 `@taizan/prisma-base` 重新拷贝 `prisma/schema/00-base/`，并刷新 `base.lock.json`
（每个片段的 sha256 + 包版本）。

**即使 CHANGELOG 说没动 schema 也建议跑一次**：`base.lock.json` 里记着包版本，
不跑的话 `apps/api/test/arch/base-schema-integrity.spec.ts` 会因为版本对不上而红。

跑之前如果本地对 `00-base/` 有未提交的改动，`sync` 会直接覆盖掉——
但那本来就是不该存在的改动（见 `docs/PLATFORM-SCHEMA.md` §3）。

---

## 3. Review `00-base` 的 diff —— 这一步不能跳

```bash
git diff apps/api/prisma/schema/00-base
```

`schema-sync` 只负责把框架片段拼进来，**它不判断「这个改动我们能不能接受」**。
重点看这三类：

| 看什么 | 为什么危险 | 怎么办 |
| --- | --- | --- |
| 新增**非空且无默认值**的列 | 已有数据的表加这种列，生成的 SQL 在生产直接失败 | 拆三步：加可空列 → 写脚本回填 → 单独一次迁移改非空 |
| 变窄的类型 / 删列 / 改列名 | 数据会丢，且不可逆 | CHANGELOG 里这类必然是 major 且附了数据迁移脚本，照着走。先在只读副本上演练 |
| 新增或变更的唯一索引 | 已有数据里若有重复行，`migrate deploy` 会在**生产停机窗口里**失败 | 上线前先在生产只读副本上跑 `SELECT <列> FROM <表> GROUP BY <列> HAVING COUNT(*) > 1` |

顺带确认一下**没有**出现自己的改动被覆盖的痕迹——如果有，说明有人手改过 `00-base/`，
把那些改动挪到 `10-business/` 或提到框架去改。

---

## 4. `prisma migrate dev`

```bash
pnpm -F @taizan/api prisma:migrate      # 内部：schema-sync && prisma migrate dev
git diff apps/api/prisma/migrations     # 看生成的 SQL，不要盲信
```

生成的迁移文件要**和代码一起提交**。

生产/预发环境走 `prisma migrate deploy`（`deploy/scripts/migrate.sh` 里已经是这条路径），
**绝不用 `migrate dev`**——后者检测到 drift 时会提议重置数据库，而它在 CI 里是非交互的。

---

## 5. 跑全部 arch spec

```bash
pnpm -F @taizan/api test        # 单测 + apps/api/test/arch/**（不连库）
pnpm -F @taizan/api test:e2e    # 隔离 e2e + RBAC/计费 e2e，连 compose 起的真库
pnpm -F @taizan/admin test      # component-map 与后端菜单双向对账
pnpm test                       # turbo 全仓
```

arch spec 是升级回归的**主要判据**，不是补充。它们扫的正是「框架升级最容易破坏的东西」：

| 升级后最常红的 spec | 说明它什么变了 |
| --- | --- |
| `apps/api/test/arch/base-schema-integrity.spec.ts` | `00-base/` 与 lock 对不上 → 忘了跑 `schema-sync`，或有人手改了框架片段 |
| `apps/api/test/arch/tenant-models.spec.ts` | 框架新增了租户表，你的隔离名单还没跟上（框架侧的 10 张由 `createBaseRegistry` 自动补，这条红通常意味着**你自己的表**出了问题） |
| `apps/api/test/arch/guard-order.spec.ts` | 框架调整了守卫链顺序，或者你的 `global-providers.ts` 与新版的期望不一致 |
| `apps/api/test/arch/billing-routes.spec.ts` | `ALWAYS_WRITABLE_PREFIXES` 变了，或者你的功能项 `pathPrefixes` 盖住了续费白名单 |
| `apps/api/test/arch/permission-registry.spec.ts` | 框架内置权限点增删 |
| `packages/*/src/**` 的包内 spec | 你没改它们；红了说明是**框架的问题**，去框架仓库开 issue，不要在本地改 `node_modules` |

全绿之后再部署。任何一条红都不要用 `--reporter` 或 `.skip` 绕过——
这些 spec 拦的是「不会报错但会出事」的那一类问题（`docs/SECURITY-INVARIANTS.md`）。

---

## 6. major 变更的迁移模板

CHANGELOG 里 major 变更会附一段迁移步骤。作为**框架维护者**写这段时，
和作为**业务项目**执行这段时，都照这个模板：

````markdown
## 迁移：<从 X.Y 到 Z.0>

**影响范围**：<哪些包 / 哪些文件 / 哪些运行时行为>

**能不能不升**：<可以先停在 X.Y 多久；有没有安全修复>

### 1. 代码改动

```diff
- import { oldThing } from '@taizan/xxx'
- oldThing(a, b)
+ import { newThing } from '@taizan/xxx'
+ newThing({ a, b })
```

<每一处都给 before / after，不要只说「改成新 API」>

### 2. schema 改动

<具体哪个片段的哪一列；有数据回填时给完整 SQL 或脚本路径>

```sql
-- 先加可空列
ALTER TABLE `Xxx` ADD COLUMN `newCol` VARCHAR(26) NULL;
-- 回填
UPDATE `Xxx` SET `newCol` = ... WHERE `newCol` IS NULL;
-- 再改非空（单独一次迁移）
```

### 3. env 改动

| 变量 | 动作 | 说明 |
|---|---|---|
| `NEW_VAR` | 新增，必填 | <没有它启动会被 zod 拒掉，中文报错> |
| `OLD_VAR` | 废弃 | <还读多久；什么时候真删> |

跑 `pnpm -F @taizan/api taizan:env-example` 重新生成 `.env.example`，比对自己的 `.env`。

### 4. 验证

```bash
pnpm -F @taizan/api test
pnpm -F @taizan/api test:e2e
```

<外加这次变更专属的验证点，例如「用 A 店 token 打 B 店资源仍应返回 1240300」>

### 5. 回滚

<代码可回滚吗；schema 改动可逆吗；不可逆的话，回滚的正确做法是什么>
````

**签名 / 加解密 / 隔离决策函数的任何行为变化一律 major**（`docs/RELEASE.md` §2）。
判不准的时候按 major 走——业务项目多读一段迁移说明的成本，远低于「以为是 patch 结果线上验签全挂」。

---

## 7. 回滚

分三种情况，处理方式完全不同。

### 7.1 只改了代码（schema 没动）

把 `package.json` 的版本范围锁回上一个已知良好版本，重装、重部署：

```bash
pnpm add @taizan/xxx@1.3.5 -F @taizan/api
pnpm install
pnpm -F @taizan/api build
bash deploy/scripts/rollback.sh          # 或你自己的部署回滚路径
```

九个 `nest-*` 是 linked 组，回滚时**九个要一起锁回同一个版本**，
否则会出现 peer 冲突（`pnpm check:peer-deps` 在框架侧断言的就是这个不变量）。

### 7.2 跑过 migrate 了

**先别回滚代码。** 数据库迁移大多不可逆：
新版加的列，旧版代码不会去写它（通常没事）；但新版**改名或删掉**的列，旧版代码会去读它（直接炸）。

正确顺序：

1. 判断问题出在代码还是数据。看 `/health` 与日志的 traceId，别猜。
2. 如果是代码问题、且这次迁移只是「加了列」——**回滚代码即可**，多出来的列留着不管。
3. 如果迁移改名/删列/变窄类型——**不要回滚**，走前进式修复：
   等框架发修复版本，或在本项目里先加一个补丁层。回滚会让旧代码读不到列。
4. 真的必须回退 schema：写一个**反向迁移**（新的一次 `migrate dev`），不要 `migrate resolve --rolled-back`
   去改历史——历史改了之后，下次在另一台机器上 `migrate deploy` 会对不上。

### 7.3 框架发了坏版本

框架侧的动作（`docs/RELEASE.md` §6）：**npm 不撤包**，走 `npm deprecate` + 尽快发修复版本。
业务项目侧看到 `pnpm install` 时的 deprecate 警告，按 7.1 / 7.2 决定要不要回退。

如果坏版本已经造成了数据层面的影响（例如某个迁移带了错误的默认值），
**回退包版本解决不了问题**——需要单独的数据修复脚本，框架会随修复版本的 CHANGELOG 一起给。

---

## 8. 升级前的检查清单

- [ ] 读完了这次跨越的**所有**中间版本的 CHANGELOG「变更影响面」三栏
- [ ] 生产库有**当天的**备份，且验证过能恢复（没验证过的备份等于没有）
- [ ] 在预发环境完整走了一遍第 1–5 步
- [ ] 有唯一索引变更的：在生产只读副本上验证过没有重复行
- [ ] 有非空列新增的：确认迁移拆成了「加可空 → 回填 → 改非空」
- [ ] env 有新增必填项的：预发与生产的 `.env` 都已补齐（`taizan:env-example` 比对过）
- [ ] `pnpm -F @taizan/api test` / `test:e2e` 全绿
- [ ] 部署后跑一遍线上只读自检：
      ```bash
      bash deploy/checks/health-check.sh
      bash deploy/checks/tenant-isolation-check.sh
      bash deploy/checks/billing-check.sh
      bash deploy/checks/cron-single-check.sh
      bash deploy/checks/ratelimit-spoof-check.sh
      ```

---

## 相关文档

- `docs/RELEASE.md` — 框架侧的发布流程、semver 纪律、CHANGELOG 模板
- `docs/PLATFORM-SCHEMA.md` §6 — schema 升级那一段的细节
- `docs/SECURITY-INVARIANTS.md` — 升级后 arch spec 红了分别意味着什么
- `docs/ERROR-CODES.md` — 「新增错误码 = minor，已有错误码含义变更 = major」的完整码表
