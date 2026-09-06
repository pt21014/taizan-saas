/**
 * `pnpm -F @taizan/api seed` —— 把一个空库变成「能登进三套后台、能看到数据」的状态。
 *
 * ## 产出
 *
 * | 身份 | 登录名 | 口令 | 入口 |
 * |---|---|---|---|
 * | 平台超管 | `admin` | `admin123` | `POST /api/platform/auth/login` |
 * | 演示店 A 店主 | `13800000000` | `123456` | `POST /api/admin/auth/login` |
 * | 演示店 B 店主 | `13800000001` | `123456` | 同上 |
 *
 * 另外：两档套餐、内置角色模板、A 店 3 个商品、B 店 2 个商品。
 *
 * **两家店是刻意的**：只有一家店的库测不出隔离——任何漏掉租户条件的查询在单租户库上
 * 都是绿的。有了 B 店，`pnpm test:e2e` 才能断言「A 的 token 只看得见 A 的 3 个商品」。
 *
 * ## 三条约定（继承自 `@taizan/prisma-base` 的 `seedBase`）
 *
 * 1. **全程 upsert，重复跑不出事**；
 * 2. **不重置已有账号的口令**——seed 要是能改密码，它就是个后门；
 * 3. 用**原始** `PrismaClient`（不套租户隔离扩展）：seed 要跨租户造数，
 *    隔离扩展在没有租户上下文时会正确地抛错。
 *
 * @packageDocumentation
 */

import 'dotenv/config'

import { Prisma, PrismaClient } from '@prisma/client'
import { ulid } from '@taizan/contracts'
import { MenuRegistry, PermissionRegistry, RbacSyncService } from '@taizan/nest-rbac'
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  DEMO_OWNER_PASSWORD,
  hashPassword,
  OWNER_ROLE_CODE,
  seedBase,
  seedDemoTenant,
  type SeedContext,
} from '@taizan/prisma-base'

import { ALL_MENUS } from './registry/menus'
import { PERMISSIONS } from './registry/permissions'
import { FEATURES } from './registry/features'
import { findFirstUpsertDelegate } from './seed-delegates'

/** 第二家演示店：隔离测试的对照组。 */
const SHOP_B = {
  slug: 'demo-b',
  name: '演示商家 B',
  ownerPhone: '13800000001',
  ownerName: 'B 店店主',
} as const

/** A 店的商品。 */
const GOODS_A = [
  { name: '可乐 330ml', priceCents: 350, stock: 100, status: 'ON_SHELF' as const },
  { name: '雪碧 330ml', priceCents: 350, stock: 80, status: 'ON_SHELF' as const },
  { name: '气泡水（新品待发布）', priceCents: 500, stock: 0, status: 'DRAFT' as const },
]

/** B 店的商品。名字**故意和 A 店重一个**——唯一索引是 `[tenantId, name, deletedAt]`， */
/** 两家店可以有同名商品，这条 seed 数据就是那个约定的活体样本。 */
const GOODS_B = [
  { name: '可乐 330ml', priceCents: 400, stock: 50, status: 'ON_SHELF' as const },
  { name: 'B 店限定咖啡', priceCents: 1800, stock: 20, status: 'ON_SHELF' as const },
]

// raw-reason: seed 要跨租户造数（平台管理员、套餐、两家演示租户），
// 隔离扩展在没有租户上下文时会正确地抛错。这里必须用未叠加扩展的原始 client。
const prisma = new PrismaClient()

/**
 * A 店里那个「只看得到商品列表」的角色。
 *
 * 它存在的理由是**证明权限点真的在拦**：只有店主一个人的库测不出 RBAC——
 * 店主 `isOwner` 恒等于全部权限，无论 `PermissionsGuard` 装没装上，行为都一样。
 * 有了这个角色，`rbac-billing.e2e-spec.ts` 才能断言「他 GET 得到、POST 是 1340300」。
 */
const VIEWER_ROLE = { code: 'goods-viewer', name: '商品查看员' } as const

/**
 * A 店里挂那个角色的员工。
 *
 * **不复用 `13800000001`**——那是 B 店店主的登录账号（`StaffAccount.phone` 全局唯一），
 * 把它同时挂成 A 店的员工会让 B 店店主登录时进入「一号多店，请选店」分支，
 * 于是 README 里写的那条 B 店登录示例就不成立了。多用一个号码比改文档便宜。
 */
const VIEWER_STAFF = { phone: '13800000002', name: 'A 店商品查看员' } as const

/**
 * A 店里那张**没人用过的**员工邀请（T1-9）。
 *
 * 它存在的理由和 `VIEWER_STAFF` 一样：**证明那条路真的通**。邀请的核销端在
 * `/api/public/invites/:token/accept`，免登录、免租户——没有一张现成的邀请，
 * 开发者要先登进后台点一次「邀请员工」才能试那条路，而那正好是最容易被跳过的一步。
 *
 * `token` 写死成一个人类可读的串（不是随机串）：seed 的产出说明里要能直接打印出
 * 完整链接，让人复制到浏览器里就能试。**真实邀请的 token 是 24 字节随机数**
 * （见 `admin/staff/staff.service.ts`），这里的可读串只是开发夹具。
 */
const DEMO_INVITE = {
  token: 'demo-staff-invite-token',
  /** 不限手机号：任何人凭链接可入，方便本地随便编一个号试。 */
  phone: null,
  expiresInDays: 3650,
} as const

/**
 * 一条面向全平台的演示公告（T1-9）。
 *
 * 商家侧的 `GET /api/admin/announcements` 只看得到「已发布 + 在有效期内 + audience
 * 命中本店」的公告，三个条件缺一条都是空列表——而空列表和「接口坏了」长得一模一样。
 * 所以 seed 里必须有一条**一定看得见**的：`ALL_TENANT` + `PUBLISHED` + 无过期时间。
 *
 * `id` 写死是为了幂等：`Announcement` 上除了主键没有别的唯一键（它没有自然键——
 * 同一个标题发两次是正常需求），所以 upsert 只能按 id。这个值是一个形状合法的
 * ULID 字面量，不是随机生成的。
 */
const DEMO_ANNOUNCEMENT = {
  id: '01JZZZSEEDANN0000000000001',
  title: '欢迎使用 taizan-saas 演示环境',
  contentHtml:
    '<p>这条公告由 <code>pnpm -F @taizan/api seed</code> 写入，audience = ALL_TENANT，' +
    '所以每一家演示店都看得到它。</p>' +
    '<p>点「标记已读」会往 <code>AnnouncementRead</code> 写一条回执，' +
    '刷新之后这一行就变成已读状态。</p>',
} as const

/**
 * 演示套餐要开的功能项。
 *
 * `@taizan/prisma-base` 的内置套餐给的是 `['member', 'order']`——那是框架举的例子，
 * 与**本应用**的功能项注册表（`src/registry/features.ts` 里只有 `goods`）对不上。
 * 不修的话，演示店一建商品就是 `1540302`「当前套餐不包含商品模块」，
 * 而 `pnpm seed` 的产出说明里还写着「A 店 3 个商品」——那是最费解的一种不一致。
 *
 * 所以 seed 完框架基线之后，按本应用的注册表把体验版的 features 补齐。
 * 保留框架那两个 key 是无害的：`checkFeatureAccess` 只按注册表里的 `pathPrefixes` 匹配，
 * 认不出的 key 不影响任何路径。
 */
const DEMO_PLAN_FEATURES: readonly string[] = ['member', 'order', ...FEATURES.map((f) => f.key)]

/** 幂等地给某家店塞商品：已有同名（未软删）的就更新，没有就建。 */
async function seedGoods(
  tenantId: string,
  items: readonly {
    name: string
    priceCents: number
    stock: number
    status: 'DRAFT' | 'ON_SHELF' | 'OFF_SHELF'
  }[],
): Promise<number> {
  let created = 0
  for (const item of items) {
    // 原始 client 没有 ULID 扩展也没有租户注入，所以 id 与 tenantId 都要自己写。
    // 这是 seed 独有的待遇；业务代码里写这两个字段中的任何一个都是错的。
    const existing = await prisma.goods.findFirst({
      where: { tenantId, name: item.name, deletedAt: null },
      select: { id: true },
    })
    if (existing) {
      await prisma.goods.update({ where: { id: existing.id }, data: { ...item } })
    } else {
      await prisma.goods.create({ data: { id: ulid(), tenantId, ...item } })
      created += 1
    }
  }
  return created
}

/**
 * 喂给 `seedBase` 的 delegate 集合。
 *
 * `role` / `staff` 换成 `findFirst + create` 版本——它们的唯一键带 `deletedAt`，
 * 而 Prisma 6.19 拒绝在唯一键里传 `null`。完整理由见 `seed-delegates.ts` 的文件头。
 * 其余表的唯一键都是单列（`username` / `code` / `slug` / `phone`），原样传即可。
 */
const seedContext: SeedContext = {
  platformAdmin: prisma.platformAdmin,
  plan: prisma.plan,
  tenant: prisma.tenant,
  staffAccount: prisma.staffAccount,
  staff: findFirstUpsertDelegate(prisma.staff),
  role: findFirstUpsertDelegate(prisma.role),
  rolePreset: prisma.rolePreset,
  // T2-7：`NotifyTemplate.key` 是单列唯一索引，不带 deletedAt，原始 delegate 直接用。
  notifyTemplate: prisma.notifyTemplate,
}

/**
 * A 店的「商品查看员」角色。`permissionCodes` 里**只有** `goods:list`。
 *
 * 不用 `upsert`：`Role` 的唯一键是 `[tenantId, code, deletedAt]`，而 Prisma 6.19
 * 拒绝在唯一键里传 `null`（`seed-delegates.ts` 的文件头写了完整理由）。
 */
async function seedViewerRole(tenantId: string): Promise<string> {
  const existing = await prisma.role.findFirst({
    where: { tenantId, code: VIEWER_ROLE.code, deletedAt: null },
    select: { id: true },
  })
  const data = {
    name: VIEWER_ROLE.name,
    // 只给一个 code。写 `['goods:*']` 会在新增权限点时**静默放宽**——
    // 明天加一个 `goods:delete`，这个角色后天就能删商品了。
    permissionCodes: ['goods:list'],
    builtin: false,
  }
  if (existing) {
    await prisma.role.update({ where: { id: existing.id }, data })
    return existing.id
  }
  const created = await prisma.role.create({
    data: { id: ulid(), tenantId, code: VIEWER_ROLE.code, ...data },
  })
  return created.id
}

/**
 * 挂那个角色的员工。
 *
 * `dataScope: 'SELF'` 是故意的：它同时演示了 `@DataScope({ ownerField: 'createdBy' })`——
 * 这个人在商品列表里只看得到自己建的商品，而 seed 造的那三个商品 `createdBy` 是 null，
 * 所以他一进去看到的是空列表。**这不是 bug**，正是数据范围在生效。
 */
async function seedViewerStaff(tenantId: string, roleId: string): Promise<void> {
  const passwordHash = await hashPassword(DEMO_OWNER_PASSWORD)
  // 同框架 seed 的第二条约定：**不重置已有账号的口令**。seed 要是能改密码，它就是个后门。
  const account = await prisma.staffAccount.upsert({
    where: { phone: VIEWER_STAFF.phone },
    create: {
      id: ulid(),
      phone: VIEWER_STAFF.phone,
      passwordHash,
      name: VIEWER_STAFF.name,
      status: 'ACTIVE',
    },
    update: { name: VIEWER_STAFF.name },
  })

  const existing = await prisma.staff.findFirst({
    where: { tenantId, accountId: account.id, deletedAt: null },
    select: { id: true },
  })
  const data = {
    name: VIEWER_STAFF.name,
    status: 'ACTIVE' as const,
    roleIds: [roleId],
    dataScope: 'SELF' as const,
    isOwner: false,
  }
  if (existing) {
    await prisma.staff.update({ where: { id: existing.id }, data })
    return
  }
  await prisma.staff.create({ data: { id: ulid(), tenantId, accountId: account.id, ...data } })
}

/**
 * A 店的演示邀请。
 *
 * 幂等，且**每次 seed 都把它重置成未使用**——它是开发夹具不是业务数据，
 * 上一轮开发把它核销掉之后，下一次 `pnpm seed` 应该还能再试一遍。
 * （这与「seed 不重置已有账号的口令」那条约定不冲突：那条守的是**别人的**凭据，
 * 这里重置的是一张自己造出来的演示邀请。）
 */
async function seedDemoInvite(tenantId: string, roleId: string): Promise<string> {
  const expiresAt = new Date(Date.now() + DEMO_INVITE.expiresInDays * 24 * 60 * 60 * 1000)
  const data = {
    phone: DEMO_INVITE.phone,
    roleIds: [roleId],
    expiresAt,
    usedAt: null,
    usedBy: null,
  }
  const row = await prisma.staffInvite.upsert({
    where: { token: DEMO_INVITE.token },
    create: { id: ulid(), tenantId, token: DEMO_INVITE.token, ...data },
    update: data,
  })
  return row.token
}

/** 一条 `ALL_TENANT` 的已发布公告。幂等按 id（`Announcement` 没有自然键）。 */
async function seedAnnouncement(): Promise<void> {
  const data = {
    title: DEMO_ANNOUNCEMENT.title,
    contentHtml: DEMO_ANNOUNCEMENT.contentHtml,
    audience: 'ALL_TENANT' as const,
    audienceRefs: Prisma.JsonNull,
    level: 'INFO' as const,
    // 发布时间取「昨天」而不是 `now`：`publishAt <= now` 是可见性条件之一，
    // 用 `now` 的话，同一次 seed 里紧接着跑的断言会卡在毫秒级的边界上。
    publishAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    expireAt: null,
    status: 'PUBLISHED' as const,
  }
  await prisma.announcement.upsert({
    where: { id: DEMO_ANNOUNCEMENT.id },
    create: { id: DEMO_ANNOUNCEMENT.id, ...data },
    update: data,
  })
}

/**
 * 把一家店改成「昨天就到期了」。
 *
 * `status` 一并从 `TRIAL` 改成 `ACTIVE`、`trialEndAt` 清空：`evaluateTenantGate` 对
 * `TRIAL` 的租户优先按 `trialEndAt` 算，留着它的话改 `planExpireAt` 不会有任何效果——
 * 那种「改了没反应」最难查。
 *
 * `graceDays` 归 0：`seedDemoTenant` 给的是 3 天宽限，而宽限期内后台仍然可写，
 * 演示「到期只读」就演示不出来。
 */
async function expireTenant(tenantId: string): Promise<void> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { status: 'ACTIVE', planExpireAt: yesterday, trialEndAt: null, graceDays: 0 },
  })
}

/**
 * 把代码里的权限点 / 菜单注册表镜像进 `Permission` / `Menu` 表。
 *
 * ## 为什么在 seed 里，而不是在应用启动时
 *
 * 「启动即同步」听起来更省事，代价是**每个进程启动都会写一次库**：4 个 PM2 实例
 * 同时启动就是 4 份并发 upsert，而滚动发布期间新旧两版代码的注册表还不一样，
 * 会互相覆盖。同步是一次**发布动作**，不是一次启动动作。
 *
 * 生产上它由 `taizan-rbac-sync --adapter …`（`@taizan/nest-rbac` 的 CLI）在发布流程里跑；
 * 本地开发就是这里，跟着 `pnpm seed` 一起。
 *
 * `RbacSyncService` 手工 `new` 而不是从 Nest 容器里取：seed 是个脚本，为了两次 upsert
 * 起一整个应用（连 Redis、起队列 worker）不值得。它的三个依赖都能直接构造。
 */
async function syncRbacRegistries(): Promise<{ permissions: number; menus: number }> {
  const permissionRegistry = new PermissionRegistry([PERMISSIONS])
  const menuRegistry = new MenuRegistry(permissionRegistry, [ALL_MENUS])
  // raw-reason: Permission / Menu 是平台域镜像表（没有 tenantId 列），
  // 走 prisma.tenant 会被隔离扩展当成未登记模型直接抛错。
  const sync = new RbacSyncService({ raw: prisma }, permissionRegistry, menuRegistry)
  const report = await sync.syncAll()
  return { permissions: report.permissions.upserted, menus: report.menus.upserted }
}

async function main(): Promise<void> {
  // 1) 框架基线：平台管理员 + 两档套餐 + 内置角色模板 + 演示租户 A（slug `demo`）。
  const base = await seedBase(seedContext)
  const demoA = base.demo
  if (!demoA) throw new Error('seedBase 没有建出演示租户，withDemoTenant 被关掉了？')

  // 2) 第二家店。复用框架的 `seedDemoTenant`——它已经把「账号 → 租户 → 角色 → 成员」
  //    这个依赖顺序处理好了，自己再拼一遍只会拼错。
  const demoB = await seedDemoTenant({
    tenant: seedContext.tenant,
    staffAccount: seedContext.staffAccount,
    staff: seedContext.staff,
    role: seedContext.role,
    newId: ulid,
    now: new Date(),
    slug: SHOP_B.slug,
    name: SHOP_B.name,
    trialDays: 14,
    planId: base.plans.trial.id,
    ownerPhone: SHOP_B.ownerPhone,
    ownerPassword: DEMO_OWNER_PASSWORD,
    ownerName: SHOP_B.ownerName,
  })

  // 3) 演示套餐的功能项对齐本应用的注册表，见 DEMO_PLAN_FEATURES 的注释。
  await prisma.plan.update({
    where: { id: base.plans.trial.id },
    data: { features: [...DEMO_PLAN_FEATURES] },
  })

  // 4) 两家店各自的商品。
  const createdA = await seedGoods(demoA.tenant.id, GOODS_A)
  const createdB = await seedGoods(demoB.tenant.id, GOODS_B)

  // 5) A 店：一个只含 `goods:list` 的角色 + 一名挂着它的员工。
  const viewerRoleId = await seedViewerRole(demoA.tenant.id)
  await seedViewerStaff(demoA.tenant.id, viewerRoleId)

  // 6) B 店：**到期**。计费闸门的演示对照组。
  await expireTenant(demoB.tenant.id)

  // 7) A 店：一张没人用过的员工邀请（T1-9，演示 /api/public/invites/:token 那条路）。
  const inviteToken = await seedDemoInvite(demoA.tenant.id, viewerRoleId)

  // 8) 一条面向全平台的公告（T1-9，商家后台「平台公告」那一页的样本数据）。
  await seedAnnouncement()

  // 9) 权限点 / 菜单注册表 → DB 镜像。
  const mirror = await syncRbacRegistries()

  process.stdout.write(
    [
      '✓ seed 完成',
      `  平台超管        ${DEFAULT_ADMIN_USERNAME} / ${DEFAULT_ADMIN_PASSWORD}`,
      `  套餐            ${base.plans.trial.code} / ${base.plans.standard.code}`,
      `  角色模板        ${base.rolePresetCount} 条`,
      `  演示店 A        ${demoA.tenant.slug}（${demoA.tenant.id}）店主 ${demoA.ownerAccount.phone} / ${DEMO_OWNER_PASSWORD}`,
      `  演示店 B        ${demoB.tenant.slug}（${demoB.tenant.id}）店主 ${demoB.ownerAccount.phone} / ${DEMO_OWNER_PASSWORD}`,
      `  商品            A 店 ${GOODS_A.length} 个（本次新建 ${createdA}）、B 店 ${GOODS_B.length} 个（本次新建 ${createdB}）`,
      `  内置店主角色    ${OWNER_ROLE_CODE}`,
      `  A 店受限员工    ${VIEWER_STAFF.phone} / ${DEMO_OWNER_PASSWORD}（角色 ${VIEWER_ROLE.code}，只有 goods:list）`,
      `  B 店            **已到期**（planExpireAt = 昨天，graceDays=0）——计费闸门的对照组`,
      `  演示邀请        GET /api/public/invites/${inviteToken}（不限手机号，10 年有效，每次 seed 重置成未使用）`,
      `  平台公告        「${DEMO_ANNOUNCEMENT.title}」（ALL_TENANT / PUBLISHED，两家店都看得到）`,
      `  RBAC 镜像       Permission ${mirror.permissions} 条、Menu ${mirror.menus} 条`,
      `  通知模板        NotifyTemplate ${base.notifyTemplateCount} 条`,
      '',
      '  ⚠ 以上口令只用于本地开发，上线前必须改。',
      '',
    ].join('\n'),
  )
}

main()
  .catch((error: unknown) => {
    process.exitCode = 1
    process.stderr.write(`seed 失败：${error instanceof Error ? error.stack : String(error)}\n`)
  })
  .finally(() => {
    void prisma.$disconnect()
  })
