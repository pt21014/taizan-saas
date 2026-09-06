/**
 * **RBAC + 计费闸门 e2e** —— T1-2 / T1-4 / T1-5 的收口证明，跑在
 * `deploy/docker/docker-compose.dev.yml` 起的**真** MySQL + Redis 上。
 *
 * ```
 * pnpm dev:infra
 * pnpm -F @taizan/api prisma:migrate
 * pnpm -F @taizan/api test:e2e
 * ```
 *
 * ## 为什么必须连真库、起真 app
 *
 * 这一批断言的对象是**装配**：守卫链的顺序、中间件挂在哪条前缀上、闸门读到的租户
 * 视图是不是真的从库里来。这些东西用替身全都测不出来——替身怎么写，断言就怎么过。
 * 尤其是「顺序错了会静默放行」这种失败模式，只有真的发一个 HTTP 请求才看得见。
 *
 * ## 每个用例自带一家新店
 *
 * 到期、冻结、换套餐这些操作会**改坏**一家店，而改坏的店没法还原成「正常」再给下一个
 * 用例用（`planExpireAt` 改回去了，`PlatformGateway` 的 30 秒缓存还在）。所以每种状态
 * 各开一家新店，slug 带本次运行的随机后缀，可重复跑也不污染 seed 的演示店。
 *
 * ## `BILLING_ENFORCE` 用 override 而不是改 env
 *
 * `BillingModule.forRoot()` 在**模块求值时**读 `process.env.BILLING_ENFORCE`，
 * 而 ESM 的 import 是提升的——在测试文件里写 `process.env.X = ...` 已经晚了。
 * 绕开的办法是 `overrideProvider(BILLING_OPTIONS)`：`BillingGateGuard` 与
 * `TenantGateMiddleware` 都从这个 token 读开关，换掉它就等于换掉了 env，
 * 而且不依赖 `.env` 里当前写的是什么。
 *
 * ## 用例清单
 *
 * ① 只有 `goods:list` 的员工：写被拦 1340300、读通、菜单里没有「新增」按钮
 * ② 店主 bootstrap 的 permissions = 全部注册权限点
 * ③ 到期租户：写 1440301、读通、续费白名单（`/api/admin/auth/*`）通
 * ④ 到期租户的 C 端：`GET /api/client/goods` → 1440302
 * ⑤ `BILLING_ENFORCE=false`：③ 的写放行，且日志里有 `[BILLING_ENFORCE=false]` warn
 * ⑥ 套餐 `features: []`：写 → 1540302（与到期是**两个**码）
 * ⑦ 套餐 `quotas: { CUSTOM: 0 }`：写 → 1540301
 * ⑧ 入队 `goods.sync` → handler 被执行，traceId 链正确（新 traceId + parentTraceId + tenantId）
 * ⑨ 冻结租户（`status = SUSPENDED` + `invalidate`）：写被闸门拦下
 * ⑩ 数据范围：`dataScope: 'SELF'` 的员工只看得到自己建的商品
 * ⑪ `billing:view` / `billing:order`：内置 `manager` 角色能看账单但下不了单；
 *    到期店主仍能自助下单（附在 ③ 里，紧挨着「到期只读」的对照）
 */

import 'reflect-metadata'
import 'dotenv/config'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import type { MenuNode } from '@taizan/contracts'
import { ulid } from '@taizan/contracts'
import { BILLING_OPTIONS, PLATFORM_GATEWAY } from '@taizan/nest-billing'
import type { PlatformGateway } from '@taizan/nest-billing'
import { AppLogger } from '@taizan/nest-core'
import { RolePermissionsService } from '@taizan/nest-rbac'
import { hashPassword, seedBase } from '@taizan/prisma-base'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../src/bootstrap/app.module'
import { configureApp } from '../src/bootstrap/configure-app'
import {
  GoodsSyncHandler,
  GOODS_SYNC_JOB_NAME,
  type GoodsSyncRun,
} from '../src/modules/example-goods/goods-sync.handler'
import { ALL_PERMISSION_CODES } from '../src/registry/permissions'
import { findFirstUpsertDelegate } from '../src/seed-delegates'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/** 每次跑用一段唯一后缀，重复跑也不打架。 */
const RUN = ulid().slice(-8).toLowerCase()
const OWNER_PASSWORD = 'e2e-password-123'
/**
 * 手机号池：`137` + 本次运行的 6 位数字化后缀 + 2 位序号 = **恰好 11 位**。
 *
 * 位数是硬约束（`StaffAccount.phone` 有格式校验，多一位少一位都会被 DTO 拦成 1040000），
 * 所以序号补零而不是直接拼——序号超过 9 之后就会多出一位，那是很容易漏的一步。
 */
const PHONE_BASE = [...RUN]
  .map((c) => c.charCodeAt(0) % 10)
  .join('')
  .slice(0, 6)

function phoneFor(n: number): string {
  return `137${PHONE_BASE}${String(n).padStart(2, '0')}`
}

/**
 * 给 `login` 档限流用的假客户端 IP，从任意字符串种子派生。
 *
 * T2-6 接上限流之后，`RateLimitGuard` 会按「客户端 IP」计数所有 `@RateLimited('login')`
 * 的请求（admin / platform / client 三端共用同一个 `login` 档，见
 * `packages/ratelimit-core/src/config.ts` 的注释）——而这份 e2e 在一次运行里会真的
 * 敲十几次登录接口（每开一家店、每建一个带角色的员工都要登录一次）。不隔开的话，
 * 这些调用会被当成「同一个人反复登录」，在 `clientLimit: 10` / 5 分钟这一档上互相挤占，
 * 跑到第 11 次就变成 1042900——而这条 spec 测的是 RBAC/计费，不是限流。
 *
 * `TRUSTED_PROXY_HOPS=1`（`.env` 里的开发配置）时 `resolveIps` 只信 XFF 的**最后一段**，
 * 所以带一段合法 IPv4 的 `X-Forwarded-For` 就能让每个「模拟客户端」各自落进独立的桶——
 * 这其实更贴近真实情况：不同店主/员工本来就是从不同网络登录的。
 */
function fakeClientIp(seed: string): string {
  const codes = [...seed].map((c) => c.charCodeAt(0))
  const octet = (offset: number): number => {
    const sum = codes.reduce((acc, code, i) => acc + code * (i + offset + 1), 0)
    return (sum % 254) + 1 // 1..254，避开 0（非法段）与 255（广播，容易被当保留段）
  }
  return `10.${octet(1)}.${octet(2)}.${octet(3)}`
}

let app: INestApplication
let prisma: PrismaClient
let gateway: PlatformGateway
let platformToken = ''

function http(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0]
}

/** 成功响应的信封形状；`code` 不为 0 时直接把整个 body 打出来，省得反复加日志。 */
function expectOk<T>(body: unknown): T {
  const envelope = body as { code: number; message: string; data: T }
  expect(envelope.code, `期望 code=0，实际：${JSON.stringify(envelope)}`).toBe(0)
  return envelope.data
}

/** 取业务码。 */
function codeOf(body: unknown): number {
  return (body as { code: number }).code
}

interface Shop {
  tenantId: string
  slug: string
  /** 店主 token。 */
  token: string
  /** 店主的 Staff.id。 */
  staffId: string
  ownerPhone: string
}

/**
 * 用平台 token 开一家店并以店主身份登录。
 *
 * `/api/platform/tenants` 不传 planId → 这家店**没有套餐**，于是闸门视图的
 * `features` 是 `null`（全部可用）、`quotas` 是 `{}`（不限量）。
 * 这正是「除了我要测的那一件事，其它都别拦我」需要的起点。
 */
async function createShop(index: number): Promise<Shop> {
  const slug = `e2e-rb-${index}-${RUN}`
  const phone = phoneFor(index)
  const created = await request(http())
    .post('/api/platform/tenants')
    .set('Authorization', `Bearer ${platformToken}`)
    .send({
      slug,
      name: `E2E RBAC/Billing ${index} ${RUN}`,
      ownerPhone: phone,
      ownerPassword: OWNER_PASSWORD,
      trialDays: 30,
    })
  const data = expectOk<{ tenant: { id: string; slug: string } }>(created.body)

  const login = await request(http())
    .post('/api/admin/auth/login')
    .set('X-Forwarded-For', fakeClientIp(slug))
    .send({ phone, password: OWNER_PASSWORD, tenantId: data.tenant.id })
  const session = expectOk<{ access: string; staffId: string }>(login.body)

  return {
    tenantId: data.tenant.id,
    slug: data.tenant.slug,
    token: session.access,
    staffId: session.staffId,
    ownerPhone: phone,
  }
}

/** 给一家店造一个角色 + 一名挂着它的员工，返回该员工的 token。 */
async function createStaffWithRole(
  shop: Shop,
  spec: { phone: string; codes: string[]; dataScope?: 'ALL' | 'SELF' },
): Promise<{ token: string; staffId: string; roleId: string }> {
  const role = await prisma.role.create({
    data: {
      id: ulid(),
      tenantId: shop.tenantId,
      code: `e2e-role-${ulid().slice(-6).toLowerCase()}`,
      name: 'E2E 受限角色',
      permissionCodes: spec.codes,
      builtin: false,
    },
  })
  const account = await prisma.staffAccount.create({
    data: {
      id: ulid(),
      phone: spec.phone,
      passwordHash: await hashPassword(OWNER_PASSWORD),
      name: 'E2E 员工',
      status: 'ACTIVE',
    },
  })
  const staff = await prisma.staff.create({
    data: {
      id: ulid(),
      tenantId: shop.tenantId,
      accountId: account.id,
      name: 'E2E 员工',
      status: 'ACTIVE',
      roleIds: [role.id],
      dataScope: spec.dataScope ?? 'ALL',
      isOwner: false,
    },
  })

  const login = await request(http())
    .post('/api/admin/auth/login')
    .set('X-Forwarded-For', fakeClientIp(spec.phone))
    .send({ phone: spec.phone, password: OWNER_PASSWORD, tenantId: shop.tenantId })
  const session = expectOk<{ access: string }>(login.body)
  return { token: session.access, staffId: staff.id, roleId: role.id }
}

/**
 * 建一档套餐（平台域表，直接写库——平台后台的套餐管理接口是另一条工作流）。
 *
 * `priceCents` 默认 `0`：绝大多数用例只关心 features / quotas 的闸门效果，
 * 免费套餐更省事。真要下单拿支付参数的用例必须传一个正数——`PlanOrderService`
 * 拒绝金额为 0 的订单（`下单金额必须是正整数分`），免费套餐在这里只用来测闸门，
 * 不用来测下单这条路径。
 */
async function createPlan(spec: {
  features: string[] | null
  quotas: Record<string, number | null>
  priceCents?: number
}): Promise<string> {
  const priceCents = spec.priceCents ?? 0
  const plan = await prisma.plan.create({
    data: {
      id: ulid(),
      code: `e2e-plan-${ulid().slice(-8).toLowerCase()}`,
      name: 'E2E 套餐',
      firstPriceCents: priceCents,
      renewPriceCents: priceCents,
      periodMonths: 1,
      quotas: spec.quotas,
      features: spec.features === null ? undefined : spec.features,
      appKeys: ['admin', 'client'],
      trafficMb: 0,
    },
  })
  return plan.id
}

/**
 * 直接改库改一家店的闸门相关字段，然后**必须** `invalidate`。
 *
 * 不 invalidate 的话闸门视图还在 30 秒缓存里，改了跟没改一样——
 * 这条不只是测试的技巧，线上「续费后要不要等 30 秒才解锁」是同一件事，
 * `PlatformGateway.invalidate` 的 TSDoc 里写着「续费/改套餐/冻结解冻之后**必须**调」。
 */
async function mutateTenant(tenantId: string, data: Record<string, unknown>): Promise<void> {
  await prisma.tenant.update({ where: { id: tenantId }, data })
  gateway.invalidate(tenantId)
}

/** 建一个商品，返回 id（失败时把整个 body 打出来）。 */
async function createGoods(token: string, name: string): Promise<string> {
  const res = await request(http())
    .post('/api/admin/goods')
    .set('Authorization', `Bearer ${token}`)
    .send({ name, priceCents: 100, stock: 5, status: 'ON_SHELF' })
  return expectOk<{ goods: { id: string } }>(res.body).goods.id
}

/** 把菜单树摊平成 key 列表。 */
function menuKeys(menus: readonly MenuNode[]): string[] {
  return menus.flatMap((node) => [node.key, ...menuKeys(node.children ?? [])])
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 起一个 app，`BILLING_ENFORCE` 由参数决定。
 *
 * `registerClientMiddleware` 必须跟着传 `true`：`BillingModule.configure()` 读的是
 * 同一个 token，漏了它 C 端闸门就不挂——而不挂的表现是**放行**，用例④会绿得毫无道理。
 */
async function createApp(enforce: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BILLING_OPTIONS)
    .useValue({ enforce, registerClientMiddleware: true })
    .compile()
  const instance = moduleRef.createNestApplication({ logger: false })
  configureApp(instance)
  await instance.init()
  return instance
}

beforeAll(async () => {
  prisma = new PrismaClient()
  await seedBase(
    {
      platformAdmin: prisma.platformAdmin,
      plan: prisma.plan,
      tenant: prisma.tenant,
      staffAccount: prisma.staffAccount,
      staff: findFirstUpsertDelegate(prisma.staff),
      role: findFirstUpsertDelegate(prisma.role),
      rolePreset: prisma.rolePreset,
    },
    { withDemoTenant: false },
  )

  app = await createApp(true)
  gateway = app.get<PlatformGateway>(PLATFORM_GATEWAY)

  const login = await request(http())
    .post('/api/platform/auth/login')
    .set('X-Forwarded-For', fakeClientIp(`platform-admin-${RUN}`))
    .send({ username: 'admin', password: 'admin123' })
  platformToken = expectOk<{ access: string }>(login.body).access
})

afterAll(async () => {
  await app?.close()
  await prisma?.$disconnect()
})

// ─────────────────────────────────────────────────────────────────────────────
// ① / ② / ⑩ 权限点与数据范围
// ─────────────────────────────────────────────────────────────────────────────

describe('① 只有 goods:list 的员工', () => {
  let shop: Shop
  let viewer: { token: string; staffId: string; roleId: string }

  beforeAll(async () => {
    shop = await createShop(1)
    viewer = await createStaffWithRole(shop, { phone: phoneFor(2), codes: ['goods:list'] })
  })

  it('GET /api/admin/goods 通（有 goods:list）', async () => {
    const res = await request(http())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${viewer.token}`)
      .expect(200)
    expectOk<{ items: unknown[] }>(res.body)
  })

  it('POST /api/admin/goods → 1340300（没有 goods:write）', async () => {
    const res = await request(http())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ name: `不该建成的商品 ${RUN}`, priceCents: 100 })
    expect(codeOf(res.body)).toBe(1340300)
  })

  it('DELETE 与 export 同样被拦（三个权限点是分开的，不是一个 goods:manage）', async () => {
    const del = await request(http())
      .delete(`/api/admin/goods/${ulid()}`)
      .set('Authorization', `Bearer ${viewer.token}`)
    expect(codeOf(del.body)).toBe(1340300)

    const exported = await request(http())
      .get('/api/admin/goods/export')
      .set('Authorization', `Bearer ${viewer.token}`)
    expect(codeOf(exported.body)).toBe(1340300)
  })

  it('bootstrap：permissions 只有 goods:list，菜单里**没有**「新增」按钮项', async () => {
    const res = await request(http())
      .get('/api/admin/auth/bootstrap')
      .set('Authorization', `Bearer ${viewer.token}`)
      .expect(200)
    const data = expectOk<{ permissions: string[]; menus: MenuNode[] }>(res.body)

    expect(data.permissions).toEqual(['goods:list'])
    const keys = menuKeys(data.menus)
    expect(keys, '商品列表页要在（他有 goods:list）').toContain('goods.list')
    expect(
      keys,
      '「新增商品」按钮要求 goods:write，他没有 → pruneMenus 必须把它裁掉。' +
        '菜单裁剪与守卫判定用的是同一份 granted 集合，所以「看得到但点了 403」不该发生。',
    ).not.toContain('goods.create')
  })

  it('改了角色的权限点 + invalidateRoles 之后立刻生效（不用等 30 秒缓存过期）', async () => {
    await prisma.role.update({
      where: { id: viewer.roleId },
      data: { permissionCodes: ['goods:list', 'goods:write'] },
    })
    // 不调这一行的话，下面那个 POST 在 30 秒内仍然是 1340300——
    // 「改了权限没生效」是角色编辑功能上线后第一个被报的 bug。
    app.get(RolePermissionsService).invalidateRoles(shop.tenantId)

    const res = await request(http())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ name: `补了写权限之后建成的商品 ${RUN}`, priceCents: 100 })
    expectOk<{ goods: { id: string } }>(res.body)
  })
})

describe('② 店主的 bootstrap', () => {
  let shop: Shop

  beforeAll(async () => {
    shop = await createShop(3)
  })

  it('permissions 恒等于全部已注册权限点（店主不受角色配置限制）', async () => {
    const res = await request(http())
      .get('/api/admin/auth/bootstrap')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    const data = expectOk<{
      permissions: string[]
      menus: MenuNode[]
      tenant: { readonly: boolean; features: string[] | null }
      quotas: Record<string, { used: number; limit: number | null }>
    }>(res.body)

    expect(data.permissions).toEqual([...ALL_PERMISSION_CODES].sort())
    expect(menuKeys(data.menus)).toContain('goods.create')
    // 没挂套餐 → features 三态里的 `null`（全部可用）。**不是 `[]`**。
    expect(data.tenant.features).toBeNull()
    expect(data.tenant.readonly).toBe(false)
    // 配额清单按 registry/quota-kinds.ts 下发，哪怕计数是 0 也要出现。
    expect(Object.keys(data.quotas).sort()).toEqual(['CUSTOM', 'STAFF'])
    expect(data.quotas.CUSTOM?.limit, '没挂套餐 = 不限量').toBeNull()
  })

  it('/api/admin/bootstrap 是等价入口（续费白名单前缀的兑现者）', async () => {
    const res = await request(http())
      .get('/api/admin/bootstrap')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    expectOk<{ permissions: string[] }>(res.body)
  })
})

describe('⑩ 数据范围（@DataScope + createdBy）', () => {
  let shop: Shop
  let selfOnly: { token: string }

  beforeAll(async () => {
    shop = await createShop(4)
    // 店主先建两个商品：它们的 createdBy 是店主，不是下面那位员工。
    await createGoods(shop.token, `店主建的 A ${RUN}`)
    await createGoods(shop.token, `店主建的 B ${RUN}`)
    selfOnly = await createStaffWithRole(shop, {
      phone: phoneFor(5),
      // 带上 export：这个用例要证明「导出与列表用同一份 scope」，
      // 不给 export 权限的话它会先被 PermissionsGuard 拦成 1340300，测不到数据范围。
      codes: ['goods:list', 'goods:write', 'goods:export'],
      dataScope: 'SELF',
    })
  })

  it('SELF 范围的员工看不到别人建的商品', async () => {
    const res = await request(http())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${selfOnly.token}`)
      .expect(200)
    expect(expectOk<{ total: number }>(res.body).total).toBe(0)
  })

  it('他自己建的能看到（收窄的是「谁建的」，不是「有没有数据」）', async () => {
    await createGoods(selfOnly.token, `员工自己建的 ${RUN}`)
    const res = await request(http())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${selfOnly.token}`)
      .expect(200)
    const data = expectOk<{ total: number; items: { name: string }[] }>(res.body)
    expect(data.total).toBe(1)
    expect(data.items[0]?.name).toContain('员工自己建的')
  })

  it('店主（ALL 范围）看得到全部三个', async () => {
    const res = await request(http())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    expect(expectOk<{ total: number }>(res.body).total).toBe(3)
  })

  it('导出走同一份 scope（列表加了收窄、导出忘了加 = 一键拿走全店数据）', async () => {
    const res = await request(http())
      .get('/api/admin/goods/export')
      .set('Authorization', `Bearer ${selfOnly.token}`)
      .expect(200)
    expect(expectOk<unknown[]>(res.body)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ / ④ / ⑨ 到期与冻结
// ─────────────────────────────────────────────────────────────────────────────

describe('③ 到期租户（BILLING_ENFORCE=true）', () => {
  let shop: Shop

  beforeAll(async () => {
    shop = await createShop(6)
    await mutateTenant(shop.tenantId, {
      status: 'ACTIVE',
      planExpireAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      trialEndAt: null,
      graceDays: 0,
    })
  })

  it('POST /api/admin/goods → 1440301（到期只读，去续费）', async () => {
    const res = await request(http())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .send({ name: `到期后不该建成 ${RUN}`, priceCents: 100 })
    expect(codeOf(res.body)).toBe(1440301)
  })

  it('响应里带着「去哪续费」，而不是一句干巴巴的无权限', async () => {
    const res = await request(http())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .send({ name: `到期后不该建成 2 ${RUN}`, priceCents: 100 })
    const body = res.body as { message: string; data?: { renewalPath?: string } }
    expect(body.message).toContain('续费')
    expect(body.data?.renewalPath).toBe('/api/admin/billing')
  })

  it('GET /api/admin/goods 通（只读不是关门——商家得看得到自己欠了多少）', async () => {
    const res = await request(http())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    expectOk<{ items: unknown[] }>(res.body)
  })

  it('续费白名单 `/api/admin/auth/*` 的**写**操作照常通（换店是个 POST）', async () => {
    const res = await request(http())
      .post('/api/admin/auth/switch')
      .set('Authorization', `Bearer ${shop.token}`)
      .set('X-Forwarded-For', fakeClientIp(`${shop.tenantId}-switch`))
      .send({ tenantId: shop.tenantId })
    expectOk<{ access: string }>(res.body)
  })

  it('`/api/admin/billing` 读得到，且 readonly=true、daysLeft 是负数', async () => {
    const res = await request(http())
      .get('/api/admin/billing')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    const data = expectOk<{ readonly: boolean; daysLeft: number | null; phase: string }>(res.body)
    expect(data.readonly).toBe(true)
    expect(data.daysLeft).toBeLessThan(0)
    expect(data.phase).toBe('EXPIRED')
  })

  it('bootstrap 下发 readonly=true（前端据此把表单区置灰）', async () => {
    const res = await request(http())
      .get('/api/admin/auth/bootstrap')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    expect(expectOk<{ tenant: { readonly: boolean } }>(res.body).tenant.readonly).toBe(true)
  })

  it(
    '到期店主仍能自助下单（`billing:order` 恒在店主的全量权限里，' +
      '`/api/admin/billing` 又落在续费白名单前缀上——两道闸门都得放行）',
    async () => {
      const planId = await createPlan({ features: null, quotas: {}, priceCents: 100 })
      const res = await request(http())
        .post('/api/admin/billing/orders')
        .set('Authorization', `Bearer ${shop.token}`)
        .send({ planId, periods: 1 })
      const data = expectOk<{ order: { id: string; status: string } }>(res.body)
      expect(data.order.status).toBe('PENDING')
    },
  )
})

describe('④ 到期租户的 C 端：打烊', () => {
  let shop: Shop
  let memberToken = ''

  beforeAll(async () => {
    shop = await createShop(7)
    // **先在店还开着的时候登录会员**：C 端闸门连 `/api/client/auth/login-dev` 一起拦
    // （它就在 `/api/client` 前缀下），店关了之后再想拿 token 是拿不到的。
    const login = await request(http())
      .post('/api/client/auth/login-dev')
      .set('X-Tenant-Slug', shop.slug)
      .set('X-Forwarded-For', fakeClientIp(`${shop.slug}-client`))
      .send({ phone: phoneFor(8) })
    memberToken = expectOk<{ access: string }>(login.body).access

    await mutateTenant(shop.tenantId, {
      status: 'ACTIVE',
      planExpireAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      trialEndAt: null,
      graceDays: 0,
    })
  })

  it('GET /api/client/goods → 1440302（打烊；C 端不分读写）', async () => {
    const res = await request(http())
      .get('/api/client/goods')
      .set('Authorization', `Bearer ${memberToken}`)
    expect(codeOf(res.body)).toBe(1440302)
  })

  it('给顾客的文案里不提「欠费/到期」——那是商家与平台之间的事', async () => {
    const res = await request(http())
      .get('/api/client/goods')
      .set('Authorization', `Bearer ${memberToken}`)
    const message = (res.body as { message: string }).message
    expect(message).not.toContain('续费')
    expect(message).not.toContain('欠费')
    expect(message).toContain('打烊')
  })

  it('同一家店的商家后台**读**仍然通（两道闸门口径不同，不是一刀切）', async () => {
    const res = await request(http())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    expectOk<{ items: unknown[] }>(res.body)
  })
})

describe('⑨ 冻结租户（平台按下去的硬闸门）', () => {
  let shop: Shop

  beforeAll(async () => {
    shop = await createShop(9)
    await mutateTenant(shop.tenantId, { status: 'SUSPENDED' })
  })

  it('POST /api/admin/goods → 1440301，且理由是 SUSPENDED 而不是「到期」', async () => {
    const res = await request(http())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .send({ name: `冻结后不该建成 ${RUN}`, priceCents: 100 })
    expect(codeOf(res.body)).toBe(1440301)
    const body = res.body as { message: string; data?: { reason?: string } }
    expect(body.data?.reason).toBe('SUSPENDED')
    // 文案必须是「联系平台」而不是「请续费」——冻结的店交了钱也不会自动解冻。
    expect(body.message).toContain('冻结')
  })

  it('C 端直接打烊（硬闸门与 BILLING_ENFORCE 无关，下一个 describe 会验证这一点）', async () => {
    const res = await request(http()).get('/api/client/goods').set('X-Tenant-Slug', shop.slug)
    // 冻结的店连 slug 都解析不出来（`UNRESOLVABLE_TENANT_STATUSES`），
    // 所以这里是 1240400「店铺不存在」而不是 1440302——**这是对的**：
    // 让它解析成功再由闸门拦，会多出一整条「租户存在但不可用」的分支要每个下游处理。
    expect(codeOf(res.body)).toBe(1240400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ / ⑦ 功能开关与配额
// ─────────────────────────────────────────────────────────────────────────────

describe('⑥ 套餐 features: [] —— 一个功能都没买', () => {
  let shop: Shop

  beforeAll(async () => {
    shop = await createShop(10)
    const planId = await createPlan({ features: [], quotas: {} })
    await mutateTenant(shop.tenantId, {
      planId,
      status: 'ACTIVE',
      planExpireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      trialEndAt: null,
    })
  })

  it('POST /api/admin/goods → 1540302（升套餐），不是 1440301（续费）', async () => {
    const res = await request(http())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .send({ name: `没买商品模块 ${RUN}`, priceCents: 100 })
    expect(
      codeOf(res.body),
      '两个码必须分开：合成一个笼统的「无权限」，商家不知道该续费还是升档，只会来问客服。',
    ).toBe(1540302)
    expect((res.body as { message: string }).message).toContain('升级套餐')
  })

  it('GET 仍然通（`writeOnly: true` 只拦写，已有数据看得见）', async () => {
    const res = await request(http())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    expectOk<{ items: unknown[] }>(res.body)
  })

  it('bootstrap 里 features 是 `[]` 而不是 `null`，菜单被整块裁掉', async () => {
    const res = await request(http())
      .get('/api/admin/auth/bootstrap')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    const data = expectOk<{ tenant: { features: string[] | null }; menus: MenuNode[] }>(res.body)
    expect(data.tenant.features).toEqual([])
    expect(menuKeys(data.menus)).not.toContain('goods.list')
  })
})

describe('⑦ 配额用尽（quotas: { CUSTOM: 0 }）', () => {
  let shop: Shop

  beforeAll(async () => {
    shop = await createShop(11)
    // features 传 null（全部可用），只把配额卡死——否则先撞上的会是 1540302，
    // 那样这条用例测的就不是配额了。
    const planId = await createPlan({ features: null, quotas: { CUSTOM: 0 } })
    await mutateTenant(shop.tenantId, {
      planId,
      status: 'ACTIVE',
      planExpireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      trialEndAt: null,
    })
  })

  it('POST /api/admin/goods → 1540301（配额超限），与功能未包含是两个码', async () => {
    const res = await request(http())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .send({ name: `配额为 0 ${RUN}`, priceCents: 100 })
    expect(codeOf(res.body)).toBe(1540301)
  })

  it('被拦下之后库里没有半条数据（先占配额再写库，占不到就不写）', async () => {
    const count = await prisma.goods.count({ where: { tenantId: shop.tenantId } })
    expect(count).toBe(0)
  })

  it('把上限放开到 1 之后建得成，且 bootstrap 的 quotas 反映出用量', async () => {
    const planId = await createPlan({ features: null, quotas: { CUSTOM: 1 } })
    await mutateTenant(shop.tenantId, { planId })

    await createGoods(shop.token, `放开配额之后建成 ${RUN}`)

    const res = await request(http())
      .get('/api/admin/auth/bootstrap')
      .set('Authorization', `Bearer ${shop.token}`)
      .expect(200)
    const quotas = expectOk<{ quotas: Record<string, { used: number; limit: number | null }> }>(
      res.body,
    ).quotas
    expect(quotas.CUSTOM).toEqual({ used: 1, limit: 1 })

    // 再建一个就该超限了。
    const again = await request(http())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .send({ name: `第二个 ${RUN}`, priceCents: 100 })
    expect(codeOf(again.body)).toBe(1540301)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 队列
// ─────────────────────────────────────────────────────────────────────────────

describe('⑧ 队列：goods.sync', () => {
  let shop: Shop
  let goodsId = ''

  beforeAll(async () => {
    shop = await createShop(12)
  })

  /**
   * 每次都从容器里重新取。
   *
   * 写成 `const handler = app.get(...)` 再读 `handler.lastRun` 的话，TS 会把它
   * 沿着上一行的 `= null` 收窄成 `never`——一个纯类型层面的坑，但改法很简单。
   */
  const lastRun = (): GoodsSyncRun | null => app.get(GoodsSyncHandler).lastRun

  it('建商品会入队一条 goods.sync，handler 真的被执行', async () => {
    app.get(GoodsSyncHandler).lastRun = null

    goodsId = await createGoods(shop.token, `触发同步 ${RUN}`)

    // BullMQ 的投递是异步的，轮询而不是固定 sleep：固定 sleep 要么慢要么偶发失败。
    const deadline = Date.now() + 15_000
    while (lastRun()?.goodsId !== goodsId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(
      lastRun(),
      `15 秒内没等到 ${GOODS_SYNC_JOB_NAME} 被消费。` +
        'worker 没起来（QUEUE_ENABLED=false？@JobHandler 没进 providers？）还是入队失败了？',
    ).not.toBeNull()
    expect(lastRun()?.goodsId).toBe(goodsId)
    expect(lastRun()?.reason).toBe('create')
  })

  it('traceId 链正确：新 traceId + 指回入队方的 parentTraceId + 恢复出的 tenantId', () => {
    const run = lastRun()
    expect(run?.traceId, '执行时必须有自己的 traceId').toBeTruthy()
    expect(run?.parentTraceId, '断了这一环就没法从「用户点了哪个按钮」查到后台任务').toBeTruthy()
    expect(run?.traceId).not.toBe(run?.parentTraceId)
    expect(
      run?.tenantId,
      '漏了 tenantId 的后果不是链路断，是处理器里一用 prisma.tenant 就抛；' +
        '若处理器改用了 prisma.raw，那就是跨租户写数据。',
    ).toBe(shop.tenantId)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ BILLING_ENFORCE=false：照常计算、放行、打 warn
// ─────────────────────────────────────────────────────────────────────────────

describe('⑤ BILLING_ENFORCE=false（灰度期：算而不拦）', () => {
  let shadowApp: INestApplication
  let shop: Shop
  let warnings: string[] = []

  beforeAll(async () => {
    // 先用主 app（enforce=true）把店建好并改成到期，再起第二个 app 打请求。
    shop = await createShop(13)
    await mutateTenant(shop.tenantId, {
      status: 'ACTIVE',
      planExpireAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      trialEndAt: null,
      graceDays: 0,
    })

    shadowApp = await createApp(false)
    const logger = shadowApp.get(AppLogger)
    warnings = []
    vi.spyOn(logger, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message))
    })
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await shadowApp?.close()
  })

  function shadowHttp(): Parameters<typeof request>[0] {
    return shadowApp.getHttpServer() as Parameters<typeof request>[0]
  }

  it('同一家到期的店：写操作被**放行**', async () => {
    const res = await request(shadowHttp())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${shop.token}`)
      .send({ name: `灰度期照常建成 ${RUN}`, priceCents: 100 })
    expectOk<{ goods: { id: string } }>(res.body)
  })

  it('但日志里留下了 `[BILLING_ENFORCE=false] 若开启将拦下：…`', () => {
    const shadowed = warnings.filter((w) => w.includes('[BILLING_ENFORCE=false]'))
    expect(
      shadowed.length,
      '放行而不留痕，等于开关打开那天没人知道会锁掉谁。' +
        `实际收到的 warn：${JSON.stringify(warnings)}`,
    ).toBeGreaterThan(0)
    expect(shadowed[0]).toContain(shop.tenantId)
    expect(shadowed[0]).toContain('EXPIRED')
  })

  it('冻结/注销是**硬闸门**，开关掀不动它', async () => {
    const frozen = await createShop(14)
    await prisma.tenant.update({ where: { id: frozen.tenantId }, data: { status: 'SUSPENDED' } })
    // 两个 app 各有一份闸门视图缓存（进程内 Map），得各清各的。
    gateway.invalidate(frozen.tenantId)
    shadowApp.get<PlatformGateway>(PLATFORM_GATEWAY).invalidate(frozen.tenantId)

    const res = await request(shadowHttp())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${frozen.token}`)
      .send({ name: `冻结的店在灰度期也不该能写 ${RUN}`, priceCents: 100 })
    expect(
      codeOf(res.body),
      '把 BILLING_ENFORCE 关掉排查问题时，所有被封的违规店一起恢复营业——那是 knowledge 踩过的坑。',
    ).toBe(1440301)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑪ billing:view / billing:order —— 缺口 2 的收口
// ─────────────────────────────────────────────────────────────────────────────

describe('⑪ billing:view 与 billing:order 是两档独立的权限点', () => {
  let shop: Shop
  let managerToken = ''
  let viewOnlyToken = ''

  beforeAll(async () => {
    shop = await createShop(15)

    // 建店时 provisionTenant 已经把 BASE_ROLE_PRESETS 实例化成这家店自己的 Role，
    // 内置 `manager` 角色就在里面——不用再手工拼一份权限码。
    const managerRole = await prisma.role.findFirst({
      where: { tenantId: shop.tenantId, code: 'manager' },
    })
    if (managerRole === null) {
      throw new Error(
        'provisionTenant 没有下发内置的 manager 角色——role-presets 的 seed 被改坏了？',
      )
    }
    const managerPhone = phoneFor(16)
    const managerAccount = await prisma.staffAccount.create({
      data: {
        id: ulid(),
        phone: managerPhone,
        passwordHash: await hashPassword(OWNER_PASSWORD),
        name: 'E2E 店长',
        status: 'ACTIVE',
      },
    })
    await prisma.staff.create({
      data: {
        id: ulid(),
        tenantId: shop.tenantId,
        accountId: managerAccount.id,
        name: 'E2E 店长',
        status: 'ACTIVE',
        roleIds: [managerRole.id],
        dataScope: 'ALL',
        isOwner: false,
      },
    })
    const managerLogin = await request(http())
      .post('/api/admin/auth/login')
      .set('X-Forwarded-For', fakeClientIp(`manager-${shop.tenantId}`))
      .send({ phone: managerPhone, password: OWNER_PASSWORD, tenantId: shop.tenantId })
    managerToken = expectOk<{ access: string }>(managerLogin.body).access

    const viewer = await createStaffWithRole(shop, {
      phone: phoneFor(17),
      codes: ['billing:view'],
    })
    viewOnlyToken = viewer.token
  })

  it('内置 manager 模板能看账单（三条 GET 全通）', async () => {
    await request(http())
      .get('/api/admin/billing')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200)
    await request(http())
      .get('/api/admin/billing/plans')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200)
    await request(http())
      .get('/api/admin/billing/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200)
  })

  it('内置 manager 模板下不了单 → 1340300（只有店主能花钱，见 role-presets.ts）', async () => {
    const planId = await createPlan({ features: null, quotas: {}, priceCents: 100 })
    const res = await request(http())
      .post('/api/admin/billing/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ planId, periods: 1 })
    expect(codeOf(res.body)).toBe(1340300)
  })

  it('只有 billing:view 的自定义角色同样通读拦写（与 manager 的取舍是同一条规则，不是巧合）', async () => {
    await request(http())
      .get('/api/admin/billing')
      .set('Authorization', `Bearer ${viewOnlyToken}`)
      .expect(200)

    const planId = await createPlan({ features: null, quotas: {}, priceCents: 100 })
    const denied = await request(http())
      .post('/api/admin/billing/orders')
      .set('Authorization', `Bearer ${viewOnlyToken}`)
      .send({ planId, periods: 1 })
    expect(codeOf(denied.body)).toBe(1340300)
  })
})
