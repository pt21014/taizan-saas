# Changesets 使用说明（taizan-saas）

本仓库用 [Changesets](https://github.com/changesets/changesets) 管理 `packages/*` 的独立版本号与
CHANGELOG。改了任何一个可发布包（不在 `.changeset/config.json` 的 `ignore` 名单里）的**对外行为**，
提交前先跑一次：

```bash
pnpm changeset
```

按提示选中受影响的包、选 bump 档位（major/minor/patch）、写一句说明——它会在 `.changeset/` 下生成一个
`*.md` 文件，随 PR 一起提交。合并到 `main` 后，`.github/workflows/release.yml` 会自动开一个
"Version Packages" PR，把所有待发布的 changeset 汇总、改版本号、写 CHANGELOG；再合并那个 PR 才会真正
`npm publish`。

## 发布组织方式

- **零框架依赖包**（`contracts` / `tenant-scope` / `rbac-core` / `billing-rules` / `ratelimit-core` /
  `crypto` / `provision` / `payment-core` / `wechatpay` / `wechat-open` / `sms` / `storage` /
  `prisma-base` / `tokens` / `admin-ui` / `client-core` / `app-ui`）：各自独立版本号，互不牵连。
- **`@taizan/nest-*` 九个 Nest 适配包**：用 `linked` 分组，版本号**统一同步升级**。这九个包互相耦合
  （`nest-auth` 依赖 `nest-core`/`nest-prisma`，`nest-billing` 依赖 `nest-auth`……），如果各自独立编号，
  下游项目的 `package.json` 会迅速炸出一份彼此打架的 `peerDependencies` 版本矩阵（"nest-auth@1.3.0
  要求 nest-core@^1.2，但你装的是 nest-core@1.4.1，装不装得上看运气"）。同步升版本号是用"发布粒度变粗"
  换"永远不用对版本矩阵"。
- `apps/*`、`@taizan/_smoke`、三个 `tools/*` 配置包在 `ignore` 名单里，永远不参与版本号与发布。

## Semver 纪律（比 semver 官方定义更严格的几条，团队必须遵守）

这几条是本仓库对"什么算破坏性变更"的加严约定，**不是**"接口签名变了才算 major"这种字面判断——很多变化
表面上函数签名没变，但**行为**变了，对下游同样是破坏性的：

| 变更类型 | 判定 | 原因 |
|---|---|---|
| 签名 / 加解密 / 隔离决策函数的**任何行为变化** | **major** | 这几类函数（`@taizan/crypto` 的加解密与轮换、`@taizan/wechatpay` 的签名验签、`@taizan/tenant-scope` 的 `planTenantScope`）即使函数签名一字不改，输出/判定结果变了，下游要么解不出旧密文、要么验签结果反转、要么隔离边界悄悄挪位——任何一种都足以造成生产事故或安全洞。这类包**没有"小改动"**，只有"没改"和"major"。 |
| 新增错误码 | **minor** | 纯增量，旧客户端不认识新错误码时按未知码兜底处理，不影响既有分支。 |
| 已有错误码的**含义变更**（同一个数字代表的语义变了，即使 HTTP 语义映射不变） | **major** | 下游代码大概率按错误码分支处理过（弹提示、跳转、重试），含义一变，旧代码的分支判断全部失效且不会报错——是最隐蔽的一类破坏性变更。 |
| `@taizan/prisma-base` schema 片段的**字段变更**（增删字段、改类型、改约束） | **major** | 业务项目要跑 `pnpm taizan:schema-sync` 重新生成组合 schema、再跑 `prisma migrate`，这是需要业务方主动操作迁移的变更，即使只是加了一个可空字段也按 major 处理（"要不要动 schema"本身就是判定标准，不是"动多大"）。 |
| RBAC / 计费 / 限流等纯函数包的**判定结果变化**（同样输入、不同输出） | **major** | 参照第一条同一原则：这些包的价值就是"判定必须稳定"，判定变了即使函数名没变也是破坏性变更。 |

其余情况（新增可选参数、新增导出、修 bug 但外部可观察行为本就该如此、纯类型收紧且不影响运行时）按标准
semver 判断：新增能力 = minor，纯 bug 修复且不改变约定行为 = patch。

**判不准的时候按 major 走**——对使用框架的业务项目来说，"以为是小版本结果炸了"比"被要求走一次不必要的
升级评审"贵得多。

## CHANGELOG 格式

发布 PR 里每条变更除了 changesets 默认生成的标题/说明外，务必在描述里补一栏"变更影响面"（业务项目要不要
动 schema / env / 接线），模板见 `docs/RELEASE.md` 的「CHANGELOG 模板」一节。写 changeset 描述时直接按
那个模板填，减少发布 PR 阶段的返工。
