## 改动说明

<!-- 改了什么、为什么改。行为变更请写清改动前后的差异。 -->

## 关联 issue

<!-- 例如 Closes #123；没有可写「无」 -->

## 自检清单

- [ ] 本地已跑 `pnpm lint`、`pnpm typecheck`、`pnpm format:check`、`pnpm test`，以及 `pnpm test:arch` / `pnpm check:arch`（见 CONTRIBUTING.md）
- [ ] 改了 `packages/*/src` 的，已用 `pnpm changeset` 添加 changeset，bump 档位符合 `.changeset/README.md`
- [ ] 涉及租户隔离 / 计费 / 认证 / RBAC / 加密 / 支付 / 限流的，已对照 `docs/SECURITY-INVARIANTS.md`，且没有删改或绕过架构约束 spec
- [ ] 改了 schema 的，已生成并提交对应 migration
- [ ] 相关文档（包 README、`docs/`、错误码总表）已同步
