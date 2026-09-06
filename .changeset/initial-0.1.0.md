---
"@taizan/admin-ui": none
"@taizan/billing-rules": none
"@taizan/client-core": none
"@taizan/contracts": none
"@taizan/crypto": none
"@taizan/nest-audit": none
"@taizan/nest-auth": none
"@taizan/nest-billing": none
"@taizan/nest-core": none
"@taizan/nest-infra": none
"@taizan/nest-notify": none
"@taizan/nest-payment": none
"@taizan/nest-prisma": none
"@taizan/nest-rbac": none
"@taizan/payment-core": none
"@taizan/prisma-base": none
"@taizan/provision": none
"@taizan/ratelimit-core": none
"@taizan/rbac-core": none
"@taizan/sms": none
"@taizan/storage": none
"@taizan/tenant-scope": none
"@taizan/tokens": none
"@taizan/wechat-open": none
"@taizan/wechatpay": none
---

## 首个公开发布：0.1.0

**变更类型**：无（本 changeset 不触发版本抬升，见下方说明）

这批包在 P0–P3 阶段落地时，`package.json` 里的 `version` 已经手工定为 `0.1.0`（框架尚未有过任何公开
版本，团队约定"0.0.x 之前不存在，第一份对外可安装的版本直接从 0.1.0 起算"）。按 Changesets 的常规流程，
一个 `minor` bump 会把已经是 `0.1.0` 的包再往上抬一格变成 `0.2.0`——这不是我们想要的：我们想要的是
"把 0.1.0 原样发布出去，同时在 CHANGELOG 里留一条『这是首发』的记录"。

Changesets 自 2.26 起支持的 `none` bump 档位正好用于这种场景：参与本次 release 流水线（写进
CHANGELOG、被 `changeset version` 处理），但不改变版本号。因此上面所有包都标了 `none`。

首次执行发布流水线时的操作顺序：

1. 合并这个 changeset 到 `main`。
2. `.github/workflows/release.yml` 触发，`changesets/action` 打开 "Version Packages" PR
   （因为都是 `none`，这个 PR 只会给每个包追加一段 CHANGELOG，不改 `package.json` 里的版本号）。
3. 合并该 PR 后，CI 用当前 `package.json` 里已经写死的 `0.1.0` 跑 `pnpm release`
   （即 `changeset publish`），把 25 个可发布包首次推上 npm。

**变更影响面**：

| 是否需要动 schema | 是否需要动 env | 是否需要动接线 |
|---|---|---|
| 否 | 否 | 否（首次发布，业务项目此前未依赖过任何 `@taizan/*` 公开版本） |

后续每次真实的行为变更，都应按 `.changeset/README.md` 里的 semver 纪律表挑 major/minor/patch，
不要再用 `none`——`none` 只用于这类"版本号已经在别处定稿，只是要补发布记录"的一次性场景。
