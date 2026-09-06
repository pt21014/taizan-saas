# @taizan/provision

租户开通的**唯一一条路**。平台后台开通、官网自助注册、批量导入存量商家，三条入口都调
`provisionTenant()`，建店本身一个字都不许再写一遍。

零框架依赖：不 import `@prisma/client`、不认识 Nest、不读时钟、不生成 id、不做哈希，
可以在裸 node 里跑完单测。

---

## 为什么必须只有一条

分开写过一次就会漂。以后加一张初始化的表、改一次角色预设、多一个默认字段，只改一边就出事——
而漂掉的表现**不是报错**，是「从注册进来的店」和「运营手工开的店」在数据上不是同一种东西：
一边建了配额计数器另一边没建，一边下发了全套角色另一边只给了 owner。
然后所有下游逻辑都默认它们一样。xiaodian 就是这么坏掉的。

这条约束有两道可执行的闸：

| 闸 | 在哪 | 断言什么 |
|---|---|---|
| 调用序列比对 | `provision.spec.ts` | `PLATFORM` 与 `SIGNUP` 跑出来的 tx 调用序列**逐字节相同**；`source` / `operatorId` 不出现在任何写库载荷里 |
| 源码扫描（spec 14） | `scanTenantCreateCalls()` | 全仓 `tenant.create(` / `upsert(` / `createMany(` 只许出现在本包与白名单文件里，且白名单不许陈旧 |

---

## 三条入口怎么共用

事务由**调用方**开——这样调用方才能把「同一个事务里再写一条审计」放进去。

```ts
import { ulid } from '@taizan/contracts'
import { BASE_ROLE_PRESETS, hashPassword, verifyPassword } from '@taizan/prisma-base'
import { buildProvisionAudit, provisionTenant } from '@taizan/provision'

const deps = {
  now: () => new Date(),
  ulid,
  hashPassword,
  verifyPassword,
  rolePresets: BASE_ROLE_PRESETS, // RolePreset 表空时的回落
}

// raw-reason: 建租户是跨租户操作——这一刻租户还不存在，注入不了 tenantId。
const result = await prisma.raw.$transaction(async (tx) => {
  const created = await provisionTenant(tx, input, deps)
  await tx.platformAuditLog.create({
    data: { ...buildProvisionAudit(input, created), actorType: 'PLATFORM_ADMIN', actorName, ip, traceId },
  })
  return created
})
```

三条入口的差别**全都在 provision 之外**：

| | 平台后台开通 | 官网自助注册 | 批量导入 |
|---|---|---|---|
| `source` | `'PLATFORM'`（必带 `operatorId`） | `'SIGNUP'` | `'IMPORT'` |
| 限流 | 无（后台有守卫） | 同 IP + 同手机号一天 3 家，**成功也计数**；手机号已存在时另加一档按登录规矩的失败限流 | 无（离线任务） |
| 口令来源 | 商家自己填 / 运营生成一个初始口令线下告知 | 用户自己设 | 导入文件里给，或生成后短信告知 |
| 审计 actor | `PlatformAdmin` | 新店主自己 | `SYSTEM` |
| 返回 | 租户视图 + 初始口令（仅新账号） | slug / 后台地址 / 试用天数，**不含 token** | 汇总报表 |

### apps/api 接线步骤（T1-8 的后半段）

1. `apps/api/package.json` 加 `"@taizan/provision": "workspace:*"`。
2. `platform-tenant.service.ts`：删掉 `create()` 里那整块 `$transaction`，换成上面的形状，
   删掉文件头的 `TODO(T1-8)`。
3. 新建 `apps/api/src/modules/public/{signup.controller,signup.service,signup.rules}.ts`：
   `signup.rules.ts` 只放**这条路特有**的规则（同意条款、试用天数取值、限流档位），
   slug / 手机号 / 口令强度**一律从本包 import**，不许再写一遍。
4. `/api/public/*` **不能**登记进租户中间件的 `forRoutes`：那个中间件按 slug 找租户，
   而注册的时候租户还不存在（spec 16）。
5. `apps/api/test/arch/provision-single-path.spec.ts`：

```ts
const report = scanTenantCreateCalls('src')
expect(report.scannedFiles).toBeGreaterThan(0)
expect(report.violations).toEqual([])
```

---

## 几条刻意的决定

**不下发 token。** 注册成功后强制走一次登录。在这里签 token 等于开了第三条进后台的路：
登录接口上挂着的验证码、失败限流、账号停用判定、换店重签逻辑，注册接口一条都没有；
而它偏偏是全站唯一「谁都能调、而且会往库里写东西」的入口。

**已有手机号必须验原口令——平台后台那条路也一样。** 一号多店时账号是复用的，
不验口令的话，任何人填上别人的手机号就能在别人账号下开出一家店（而店主会在自己的店铺列表里
看见它）。这条**不给 source 开口子**：开了口子，「一条路」就名存实亡了。
运营要给已有账号开新店，让商家自己填口令，或者走邀请/转让流程。

**永不覆盖已有口令。** 改口令在这里会是一个后门：运营给某个手机号开新店，
顺带就把他别的店的登录口令改掉了。

**`ACTIVE` 必须给 `planExpireAt`。** 没有任何到期日的 `ACTIVE` 租户在 `evaluateTenantGate` 里
算出来是 `PENDING`（未开通），开出来就是打烊的——而那是一家刚收过钱的店。

**角色预设不在本包硬编。** DB 的 `RolePreset` 为空时回落到 `deps.rolePresets`，
两边都空就抛 `ROLE_PRESET_EMPTY`。本包自带一份的话，它就成了角色预设的第二个真源，
而「两个真源」正是这个包在防的事。

---

## 两个入口

本包 tsup 打了**两个**独立入口（`splitting: true`，见 `tsup.config.ts` 与
`scripts/check-dist-identity.mjs`），职责完全分开：

| 入口 | 谁用 | 装的是什么 |
|---|---|---|
| `@taizan/provision` | 浏览器 + node，任何地方 | `provisionTenant` / `ProvisionError` / 纯规则函数（`validateSlug`/`normalizePhone`/`assertOwnerPasswordPolicy`/…）/ `RESERVED_SLUGS` / 各种类型。**零 node 内置模块依赖**，`vite dev`/`vite build` 都能直接 `import` |
| `@taizan/provision/arch` | 只给跑在 node 进程里的架构测试 | `scanTenantCreateCalls`（spec 14 的扫描器）与 `SENTINEL_SOURCE`。顶层 `import { readdirSync } from 'node:fs'` |

**为什么要拆**：这两类导出曾经挤在同一个 `dist/index.js` 里。`vite build` 靠 Rollup 的
tree-shaking + external 能绕过去，但 `vite dev` 走原生 ESM、无条件求值整个模块——浏览器
请求这个文件时，`import ... from 'fs'` 落到 Vite 的浏览器兼容桩对象上，一访问属性就抛错，
整页 React 挂载失败（白屏）。`apps/site` 曾因此被迫在构建期生成一份纯数据文件绕过
（见该应用 README 历史记录），现在直接改回 `import from '@taizan/provision'`。

`scripts/check-dist-identity.mjs`（挂在 `pnpm test` 里，`vitest run` 之后跑）钉死两条：
1. 两个入口如果出现共享运行时导出，必须是同一个引用（程序化算交集，交集为空就是「本包现在没有这个问题」）；
2. **`dist/index.js` 与 `dist/index.cjs` 里不许出现 `node:fs`/`node:path`/`require("fs")`
   字样**——这是这次拆分真正要守住的东西，直接读构建产物的文本断言，不依赖「相信没人
   会在 `src/index.ts` 手滑 re-export `arch/`」。

架构测试改用法：

```ts
// apps/api/test/arch/provision-single-path.spec.ts
import { scanTenantCreateCalls, SENTINEL_SOURCE, SENTINEL_EXPECTATION } from '@taizan/provision/arch'
```

## 导出

| 名字 | 入口 | 说明 |
|---|---|---|
| `provisionTenant(tx, input, deps)` | 主入口 | 唯一入口。全程在调用方的事务里，失败抛 `ProvisionError` |
| `buildProvisionAudit(input, result)` | 主入口 | 拼审计载荷（`ip` / `traceId` 由调用方补） |
| `ProvisionError` / `isProvisionError` | 主入口 | 带稳定 `reason` 的失败；按 `reason` 映射错误码，别比对文案 |
| `validateSlug` / `normalizePhone` / `assertOwnerPasswordPolicy` / `decideInitialStatus` | 主入口 | 纯函数规则，注册页与后台表单共用 |
| `RESERVED_SLUGS` / `SLUG_PATTERN` | 主入口 | 保留字与形状 |
| `scanTenantCreateCalls` / `SENTINEL_SOURCE` | `./arch` | spec 14 的扫描器与哨兵 |
