# 发布治理（T4-6）

本文档是 taizan-saas 框架对外发布 `packages/*` 到 npm 的唯一操作手册，覆盖：发布流程、版本号纪律、
CHANGELOG 模板、业务项目升级步骤、回滚策略。配套文件：

- `.changeset/config.json` — access、baseBranch、`updateInternalDependencies`、`linked`（9 个
  `@taizan/nest-*` 同步版本）、`ignore`（apps + 三个 `tools/*` 配置包，永不发布）。
- `.changeset/README.md` — semver 纪律表（更严格版，行为变化优先于字面签名判断）。
- `scripts/check-peer-deps.ts` — 发布前的静态校验闸门（见下文「发布流程」第 3 步）。
- `scripts/check-changeset.mjs` — PR 检查：改了 `packages/*/src` 却没带 changeset 就红。
- `.github/workflows/release.yml` — push `main` 后自动跑 Version PR → Publish。

## 1. 发布流程

```
开发者改动 packages/*             → 跑 `pnpm changeset` 生成一个 .changeset/*.md，随 PR 提交
PR 合并到 main                    → release.yml 触发
  ├─ 若有待处理的 changeset       → changesets/action 开 "Version Packages" PR
  │                                  （pnpm version-packages：改版本号 + 生成 CHANGELOG）
  └─ 合并 "Version Packages" PR   → release.yml 再次触发，这次没有待处理 changeset
                                     → changesets/action 执行 pnpm release（changeset publish）
                                     → 发布前依次跑：pnpm build && pnpm test && pnpm check:peer-deps
                                     → 三步任一失败，直接不发布
```

**关键前提**：`NPM_TOKEN`（有 publish 权限的 npm token）必须配成仓库 Secret；`GITHUB_TOKEN` 用
workflow 自带的默认值即可（用于 changesets/action 开 PR）。发布固定走 `https://registry.npmjs.org`
——CI 或本机 `.npmrc` 里为了装依赖配的国内镜像（淘宝源等）只用于 `pnpm install`，不参与
`npm publish`；`release.yml` 里通过 `actions/setup-node` 的 `registry-url` 与显式的
`npm_config_registry` 环境变量把这一点钉死。

本地手动发起一次 changeset（日常开发在 PR 里做的事）：

```bash
pnpm changeset          # 交互式：选包、选 bump 档位、写说明
pnpm changeset status   # 查看当前有哪些待发布变更（本地/CI 都能跑，需要能访问到 baseBranch 的历史）
```

## 2. 版本号纪律

见 `.changeset/README.md` 的完整表格，核心结论：

| 变更类型 | 判定 |
|---|---|
| 签名 / 加解密 / 隔离决策函数的任何行为变化 | major |
| 新增错误码 | minor |
| 已有错误码含义变更 | major |
| `@taizan/prisma-base` schema 片段字段变更 | major（业务项目要迁移） |
| 判不准 | 按 major 走 |

`@taizan/nest-*` 九个包用 `linked` 分组，任何一个包发新版本，changesets 会把另外八个一起同步到相同版本
号（即使它们本身没有代码变化，也会各自生成一条"随组同步"的 CHANGELOG 记录）。这是发布粒度上的取舍：
换来的是业务项目的 `package.json` 永远不会出现"nest-auth 要求 nest-core@^1.2 但装的是 1.4"这种
peer 矩阵冲突。

## 3. 发布前的静态校验（`pnpm check:peer-deps`）

在 `pnpm build && pnpm test` 之后、`changeset publish` 之前，CI 会跑这一条，它断言：

1. 蓝图 §2 标为"零框架依赖"的包，`dependencies` 里不出现 `@nestjs/*` / `@prisma/client` / `react` /
   `@tarojs/*` / `expo`。
2. 九个 `@taizan/nest-*` 把 `@nestjs/*` / `@prisma/client` / `ioredis` / `bullmq` / `rxjs` 放进
   `peerDependencies`，不放进 `dependencies`。
3. 所有 `@taizan/*` 内部依赖用 `workspace:*`。
4. 每个应当可发布的包都有 `exports` / `types` / `files`，且 `publishConfig.access` 为 `"public"`。
5. `linked` 组（九个 Nest 适配包）内版本号一致。

这条脚本任何一条不过就直接非零退出，**不允许因为"现状不达标"而放宽规则**——现状不达标本身就是需要
排期修的技术债，见本次任务报告里列出的违规清单。

## 4. CHANGELOG 模板

写 `pnpm changeset` 的描述、或直接编辑 `.changeset/*.md` 时，按这个模板填（尤其是"变更影响面"三栏，
这是业务项目升级前唯一需要看的部分，比变更本身的技术描述更重要）：

```markdown
## <一句话概括变更>

**变更类型**：major / minor / patch

<正文：具体改了什么、为什么改、旧行为 vs 新行为的对比>

**变更影响面**：

| 是否需要动 schema | 是否需要动 env | 是否需要动接线 |
|---|---|---|
| 是/否，若是则说明具体哪个 prisma 片段字段 | 是/否，若是则说明新增/废弃哪个环境变量 | 是/否，若是则说明模块装配/守卫顺序/装饰器用法要不要改 |

<若「变更类型」是 major，额外写一段迁移步骤，对应第 5 节>
```

## 5. 业务项目升级框架的标准步骤

业务项目（用 `create-taizan-saas` 生成、已经在跑的实际项目）升级某个 `@taizan/*` 包版本时，按顺序走：

1. **升版本**：`pnpm update @taizan/xxx --latest`（或手动改 `package.json` 里的版本范围），读对应包
   在这次升级跨越的所有版本的 CHANGELOG，重点看每条的「变更影响面」三栏。
2. **`pnpm taizan:schema-sync`**：如果 CHANGELOG 提示动了 `@taizan/prisma-base` 的 schema 片段，跑
   这个命令重新生成组合后的 `prisma/schema`（`apps/api` 里已经接好这个 script）。
3. **review diff**：`git diff prisma/schema`，人工确认新增/变更的字段符合预期，尤其是索引与约束——
   `schema-sync` 只负责把框架片段和业务自己的模型拼起来，不负责判断"这个改动我们能不能接受"。
4. **`prisma migrate`**：本地先 `prisma migrate dev` 走一遍，确认迁移能生成、能跑；预发/生产环境走
   `prisma migrate deploy`（`deploy/scripts/migrate.sh` 里已经是这条路径）。
5. **跑 arch spec**：`pnpm -F api test`（覆盖 `apps/api/test/arch/*`，即蓝图 §8 的隔离/权限/审计等
   16 条不变量）以及 `pnpm -F api test:e2e`，确认框架升级没有破坏本项目对不变量的依赖方式。

如果 CHANGELOG 没提示 schema/env/接线变更（三栏全否），跳过 2-4 步，只需要跑 5 做回归确认。

## 6. 回滚策略

**npm 不支持撤包**（`npm unpublish` 有 72 小时窗口限制且官方强烈不建议，公开包一旦有其他项目在用，撤
包会直接让下游装不上依赖）。因此本仓库的回滚策略是"前进式修复"而不是"撤销"：

1. **发现坏版本后，第一时间 `npm deprecate`**：
   ```bash
   npm deprecate @taizan/xxx@1.4.0 "已知问题：<一句话>，请升级到 1.4.1 或回退到 1.3.x"
   ```
   这不会让已经装了这个版本的项目break，只会在 `pnpm install` 时打印警告，并且后续新装会看到提示。
2. **尽快发一个修复版本**（patch 或按实际严重程度定档），在其 changeset 描述里写清楚
   "修复 1.4.0 引入的 <问题>"，并在该版本的 CHANGELOG 顶部单独加一行"已知问题"说明。
3. **业务项目侧的回退**是业务项目自己在 `package.json` 里把版本范围锁回上一个已知良好版本
   （`pnpm add @taizan/xxx@1.3.5`），这一步框架侧管不了，只能通过清晰的 CHANGELOG + deprecate 警告
   引导业务项目自己决定要不要回退。
4. 如果坏版本已经造成了数据层面的影响（例如某个 schema 迁移带了错误的默认值），**不要**指望"回退包
   版本"就能解决问题——需要单独出一个数据修复脚本，随修复版本的 changeset 一起说明，这类情况必须在
   CHANGELOG「变更影响面」的 schema 栏里写清楚。
