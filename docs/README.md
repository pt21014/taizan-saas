# 文档索引

taizan-saas 的全部文档。按「你现在要干什么」找，而不是按目录顺序读。

---

## 按场景

| 你要干什么 | 读这个 |
| --- | --- |
| 第一次接触这个仓库 | 根 [`README.md`](../README.md) → 本页 |
| 动隔离 / 计费 / 认证 / 支付相关的代码 | [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md) ← **先读这个** |
| 加一个业务模块 | [`EXTENSION-POINTS.md`](EXTENSION-POINTS.md) |
| 加一张表 / 想知道框架表哪些字段不许改 | [`PLATFORM-SCHEMA.md`](PLATFORM-SCHEMA.md) |
| 前端要做错误分流 / 要加自己的错误码 | [`ERROR-CODES.md`](ERROR-CODES.md) |
| 业务项目要升 `@taizan/*` 版本 | [`UPGRADE.md`](UPGRADE.md) |
| 要给框架发一个版本 | [`RELEASE.md`](RELEASE.md) |
| 想知道「为什么这么设计」 | [`框架设计蓝图.md`](框架设计蓝图.md) |
| 想知道某个能力从哪来、为什么这么抽 | [`多租户SaaS基座-抽取评估报告.md`](多租户SaaS基座-抽取评估报告.md) |
| 想知道还有什么没做 | [`任务分解.md`](任务分解.md) |

---

## 全部文档

### 设计与规划

| 文档 | 内容 | 谁维护 |
| --- | --- | --- |
| [`框架设计蓝图.md`](框架设计蓝图.md) | 目录树、27 包清单、基础 schema、核心机制接口签名、前端基座、生成器设计、业务扩展七件事、**§8 十六条架构约束**、**§9 与老项目硬性约定的对照表** | 架构负责人。改设计先改这里 |
| [`任务分解.md`](任务分解.md) | T0 ~ T4 全部任务：目标、产出文件、依赖、验收、用哪个模型 | 同上 |
| [`多租户SaaS基座-抽取评估报告.md`](多租户SaaS基座-抽取评估报告.md) | 从 knowledge / xiaodian 逐模块判断「搬 / 改 / 新写」的依据，含代码行数与风险 | 一次性产出，不再更新 |

### 契约与红线

| 文档 | 内容 | 怎么保证不过时 |
| --- | --- | --- |
| [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md) | 全部安全不变量的四栏表：**不变量 → 由谁承接 → 违反时哪个 spec 会红 → 为什么**（一句踩坑史）。末尾是「待补」清单：当前没有机器守着的条目 | 引用的 spec 文件名全部真实存在；新增 spec 时把对应行的「待补」去掉 |
| [`PLATFORM-SCHEMA.md`](PLATFORM-SCHEMA.md) | `@taizan/prisma-base` 27 张表的契约：用途、平台域/租户域、关键字段与枚举、**不许改的字段**、能加什么、`schema-sync` + `base.lock.json` 机制、升级迁移流程 | 与 `packages/prisma-base/README.md` 互为详略两版；schema 变更由 `packages/prisma-base/src/schema.spec.ts` 断言 |
| [`ERROR-CODES.md`](ERROR-CODES.md) | 全部 7 位错误码总表 + 编码规则 + 前端一行判定 + 待收编清单 | **自动生成**：`pnpm docs:error-codes`；CI 跑 `pnpm docs:error-codes --check`，与源码不同步就红。**不要手改这个文件** |
| [`EXTENSION-POINTS.md`](EXTENSION-POINTS.md) | 业务扩展七件事的逐文件手册（以 `example-goods` 为样板）+ 前端两步 + 完整 checklist + 三个最常见的错误 | 与 `apps/api/README.md` §3（速查版）、`packages/admin-ui/README.md`（前端侧）配套 |

### 流程

| 文档 | 内容 |
| --- | --- |
| [`RELEASE.md`](RELEASE.md) | 框架侧：changeset 流程、semver 纪律（签名/加解密/隔离决策的任何行为变化 = major）、`check-peer-deps` 闸门、CHANGELOG 模板（含**变更影响面三栏**）、回滚策略 |
| [`UPGRADE.md`](UPGRADE.md) | 业务项目侧：升版本 → `schema-sync` → review diff → `migrate dev` → 跑全部 arch spec；major 迁移模板；三种回滚场景；升级前检查清单 |

### 模板

| 文件 | 内容 |
| --- | --- |
| [`templates/CLAUDE.md.hbs`](templates/CLAUDE.md.hbs) | 生成项目的 `CLAUDE.md` 模板。16 条硬性约定逐条写明「违反时哪个 spec 会红」，外加七件事速查、禁止事项清单、给 AI 协作者的「改了什么必跑什么」对照表。Handlebars 变量与蓝图 §6 一致 |

> `templates/` 目前只有这一份。生成器 `tools/create-taizan-saas/templates/` 建成后会把它搬过去
> （T4-1，**进行中**），本目录这份届时作为唯一真源保留还是删除，由 T4-1 决定。

---

## 各包与各端的 README

框架文档讲**跨包的约定**，README 讲**这个包怎么用、哪里容易踩**。最值得读的：

| README | 为什么值得读 |
| --- | --- |
| [`apps/api/README.md`](../apps/api/README.md) | 本地起步、三套身份怎么登录、七件事速查、arch spec 清单、守卫链顺序、**§6 已知取舍与待办** |
| [`packages/prisma-base/README.md`](../packages/prisma-base/README.md) | 表清单、`schema-sync` CLI 参数、怎么登记业务表、怎么加加密列、**§7 MySQL 唯一索引与 NULL 的那个坑** |
| [`packages/admin-ui/README.md`](../packages/admin-ui/README.md) | 装进一个 Vite 应用的三步、服务端菜单接成路由、**一个业务页面的 41 行范式**、`componentKey` 双向对账 |
| [`packages/nest-infra/README.md`](../packages/nest-infra/README.md) | 队列 / 锁 / `@LeaderCron` / 幂等 / 缓存租户前缀怎么用 |
| [`packages/wechatpay/README.md`](../packages/wechatpay/README.md) | V3 签名、回调解密、服务商分账、虚拟支付的实操细节 |

---

## 文档纪律

1. **每条红线都要写「为什么」。** 只写「不许 X」的规则，三个月后一定会有人以「优化」的名义删掉它。
   写清楚它拦的是哪一次事故，规则才立得住。
2. **引用 spec 必须用真实存在的文件名。** 指向不存在的文件比不指向更糟——读者会以为有机器在守，
   于是不再自己检查。没有 spec 的条目明确写「待补」。
3. **能自动生成的就不要手写。** `ERROR-CODES.md` 由脚本生成并有 `--check` 守着；
   `.env.example` 由 zod schema 生成。手写的表三个月后必然与代码对不上。
4. **文档与 README 分工**：跨包的约定进 `docs/`，单包的用法进那个包的 README。
   同一件事在两处都写，改的时候只会改一处。
