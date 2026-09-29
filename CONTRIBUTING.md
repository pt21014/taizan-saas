# 参与贡献

感谢你愿意改进 taizan-saas。这份文档讲的是**怎么把改动顺利合进来**：环境怎么搭、提交前跑什么、
哪些代码有额外要求。所有命令都是 CI 里真实在跑的那几条，本地过了，CI 基本就过了。

报告安全漏洞请**不要**开 issue 或 PR，见 [`SECURITY.md`](SECURITY.md)。

---

## 开发环境

前置：**Node ≥ 22**（CI 钉在 22）、**pnpm 11**（版本以根 `package.json` 的 `packageManager` 为准）、Docker。

```bash
pnpm install
pnpm dev:infra                       # MySQL(宿主 3307) + Redis(宿主 6380)
pnpm -F @taizan/api prisma:migrate   # 建表
pnpm -F @taizan/api seed             # 造演示数据
pnpm dev                             # turbo 起全部端；也可以 pnpm -F <包名> dev 单起
```

停掉基础设施并清空数据：`pnpm dev:infra:down`。更多起步细节见 [`README.md`](README.md#10-分钟起步)。

几件全新 checkout 上容易撞到的事（CI 首跑时都踩过，原因见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 文件头）：

- typecheck、架构约束、e2e 都 import workspace 包的**编译产物**。没有 `dist/` 时先
  `pnpm build --filter './packages/*' --filter './tools/*'`。
- 凡是跑 `apps/api` 代码或做 typecheck 之前，先 `pnpm -F @taizan/api prisma:generate`。

---

## 提 PR 的流程

1. 从最新的 `main` 拉分支，分支名随意，能看出在做什么即可。
2. **小步 PR**：一个 PR 只做一件事。重构和行为变更分开提；动了框架包又要改参考应用的，
   能拆就拆。大改动先开 issue 讨论方向，免得写完才发现方向不对。
3. 提交前跑完下面「本地必跑的检查」。
4. 改了 `packages/*` 的行为，带上 changeset（见下文）。
5. 开 PR，按模板填完自检清单。CI 全绿、review 通过后合并。

### 提交信息

沿用仓库现有风格：**类型前缀 + 中文描述**，一句话说清改了什么。

```
fix: 放行 .env.*.example 与 .env.example.hbs，补入被 gitignore 挡掉的 5 个模板/示例文件
chore: 用 .gitattributes 钉死全仓 LF 换行
ci: 各 job 先构建 workspace 包；site tokens.css 改为构建期生成物
```

常用前缀：`feat` / `fix` / `refactor` / `test` / `docs` / `chore` / `ci`。

---

## 本地必跑的检查

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）按下面顺序跑，PR 上任一步红都不会合并：

```bash
# 前置（全新 checkout 才需要）
pnpm build --filter './packages/*' --filter './tools/*'
pnpm -F @taizan/api prisma:generate

# quality
pnpm lint
pnpm typecheck
pnpm format:check                        # 红了就 pnpm format
pnpm check:peer-deps
node scripts/check-changeset.mjs         # 与 origin/main 比较；也可 --staged 只查暂存区
pnpm docs:error-codes --check            # 加了错误码要先跑 pnpm docs:error-codes
pnpm license:check                       # 新增可发布包要先跑 pnpm license:sync

# unit
pnpm build
pnpm test

# arch
pnpm test:arch                           # 16 条架构约束
pnpm check:arch                          # 注入 4 类违规，验证守卫真的会红
```

需要真库的两项（先 `pnpm dev:infra`）：

```bash
pnpm test:e2e                            # 隔离 / RBAC / 计费 e2e
```

`migrate-check` 会校验 migrations 与 schema 没有漂开：改了 `apps/api/prisma/schema` 就必须
用 `pnpm -F @taizan/api prisma:migrate` 生成对应迁移并一起提交。

改了 `tools/create-taizan-saas`、模板或 `packages/*` 时，PR 上还会触发
[`generator-e2e.yml`](.github/workflows/generator-e2e.yml)（十几分钟）。本地对应命令是
`pnpm acceptance`；改了参考应用导致模板快照过期时，跑 `pnpm build:templates` 刷新。

---

## 何时需要 changeset

规则很简单：**改了 `packages/*/src` 就必须带一个 `.changeset/*.md`**，否则 `check-changeset` 会红。

```bash
pnpm changeset          # 交互式：选包、选 bump 档位、写说明
pnpm changeset status   # 看当前有哪些待发布变更
```

bump 档位按 [`.changeset/README.md`](.changeset/README.md) 的纪律表挑，核心几条：

- 签名 / 加解密 / 隔离决策函数的任何行为变化 → **major**；
- 新增错误码 → minor；已有错误码含义变更 → major；
- `@taizan/prisma-base` schema 片段字段变更 → major；
- 判不准 → 按 major 走。

`@taizan/nest-*` 九个包是 `linked` 分组，版本会一起走。`apps/*` 与三个配置包
（`tools/tsconfig` / `eslint-config` / `prettier-config`）不发布，不需要 changeset。
发布流程本身见 [`docs/RELEASE.md`](docs/RELEASE.md)。

---

## 安全相关代码：额外要求

动**租户隔离、计费闸门、认证 / RBAC、加密与密钥轮换、支付回调、限流**相关代码之前，
先读 [`docs/SECURITY-INVARIANTS.md`](docs/SECURITY-INVARIANTS.md)，并在 PR 里说明这次改动与哪几条不变量有关。

`apps/api/test/arch/` 下的架构约束 spec 与 `scripts/check-arch.ts`、`scripts/check-peer-deps.ts`
是这些不变量的可执行版本。**不接受删除、放宽、`skip` 或绕过它们的 PR**——如果你认为某条约束本身错了，
先开 issue 讨论，改约束和改代码分成两个 PR。

---

## 新增 package

- 照抄 [`packages/_smoke`](packages/_smoke)：它是工具链样板包，build / test / lint / typecheck 四件套
  的配置形状都在里面。
- **零框架依赖**的包（能力总览里第一组）不能引入 `@nestjs/*`、`@prisma/client`，也不能引入
  `react`、`@tarojs/*`、`expo`；它们必须能在裸 node 里跑单测。新增零框架依赖包时，要把目录名登记到
  `scripts/check-peer-deps.ts` 的清单里。
- Nest 适配包把 `@nestjs/*`、`@prisma/client`、`ioredis`、`bullmq`、`rxjs` 放进 `peerDependencies`。
- 内部依赖一律写 `workspace:*`。
- 可发布的包要有 `exports` / `types` / `files`、`publishConfig.access: "public"`，以及
  `license: "MIT"` 和指向本仓库的 `repository` 字段。
- 可发布的包还要跑一次 `pnpm license:sync`，把根 `LICENSE` 复制进包目录并一起提交
  （npm 不会把根 LICENSE 打进子包；CI 的 `pnpm license:check` 会查）。

---

## 文档

改了行为就同步文档：包自己的 README、[`docs/`](docs/README.md) 下对应的契约文档、错误码总表
（生成物，不要手改）。所有文档用中文。

## 许可证

提交贡献即表示你同意你的贡献以 [MIT 许可证](LICENSE) 发布。
