/**
 * **蓝图 §6 的 9 条验收断言** —— 框架是否可交付的唯一判据。任一条失败即视为未完成。
 *
 * 跑法：`pnpm acceptance`（仓库根）。单跑这一份：`pnpm -F create-taizan-saas test:e2e`。
 *
 * ## 这份文件断言的对象是什么
 *
 * 不是本仓库的 `apps/api`，而是**生成器从空目录吐出来的那个项目**里、由 `tsup` 打出来的
 * `dist/main.js` 起的一个真进程（`e2e/harness.ts` 负责把它立起来）。所以下面每一条
 * 都是纯 HTTP：没有 `Test.createTestingModule`，没有 `overrideProvider`，
 * 拿不到任何 DI 容器里的东西。这是刻意的——用户手上就只有 HTTP。
 *
 * 一个直接的好处：`BillingModule.forRoot()` 在**模块求值时**读 `process.env`，
 * 在测试文件里改 env 已经晚了（`apps/api/test/rbac-billing.e2e-spec.ts` 为此要
 * `overrideProvider(BILLING_OPTIONS)`）。子进程的 env 在启动前就写好了，绕开了整件事。
 *
 * ## 不写一行业务代码
 *
 * 9 条全部走生成项目自带的 `example-goods` 模块与框架接口。唯一一处「越过 HTTP」的动作是
 * 第 ⑧ 条把 `planExpireAt` 改成昨天——那正是蓝图的原话，而且平台侧只有续期接口
 * （只会把到期时间往后推），没有「往前调」的接口。
 *
 * ## 9 条之间是有先后的
 *
 * ② 建出来的租户是 ④ 换店的目的地、也是 ⑦ 的对照组；⑤ 的会员 token 必须在 ⑧ 关店之前拿到
 * （关店之后连 `login-dev` 都会被 `1440302` 挡住）；⑧ 下的那笔订单就是 ⑨ 要付的那笔。
 * 所以 `vitest.e2e.config.ts` 里 `bail: 1`：第一条红之后，后面的只会产生噪音。
 *
 * @packageDocumentation
 */

import { createHmac } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { call, type Acceptance, type Called, setupAcceptance } from './harness'

// ─── seed 出来的固定账号（`@taizan/prisma-base` 的 seedBase + apps/api/src/seed.ts）───

/** 平台超管。`DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD`。 */
const PLATFORM_ADMIN = { username: 'admin', password: 'admin123' } as const
/** 租户 A：演示商家，TRIAL，14 天试用期内。 */
const SHOP_A_SLUG = 'demo'
/** 租户 A 的店主账号（一号多店：② 会把它再挂到租户 B 上）。 */
const OWNER = { phone: '13800000000', password: '123456' } as const
/** C 端会员：`login-dev` 会按手机号自动建号，不需要 seed。 */
const MEMBER_PHONE = '13700000009'
/** 付费套餐 `standard`：首购 99800 分 / 12 个月。⑨ 要的就是一笔非零金额的订单。 */
const PAID_PLAN_CODE = 'standard'

/** `@taizan/payment-core` 的 `FAKE_DEFAULT_SECRET`；`PaymentModule.forRoot({useFake:true})` 不传 secret 时就是它。 */
const FAKE_SECRET = 'taizan-fake-provider-secret'
/** `FAKE_SIGNATURE_HEADER`。 */
const FAKE_SIG_HEADER = 'x-taizan-fake-signature'

// ─── 响应形状（只声明断言真正用到的字段）─────────────────────────────────────

interface LoginData {
  access: string
}
interface StaffSession {
  needChooseShop: boolean
  access: string
  tenantId: string
  staffId: string
  shops: { tenantId: string; slug: string; isOwner: boolean }[]
}
interface Page<T> {
  items: T[]
  total: number
}
interface PlanRow {
  id: string
  code: string
  firstPriceCents: number
  periodMonths: number
}
interface TenantRow {
  id: string
  slug: string
  status: string
  planExpireAt: string | null
}
interface CreateTenantResult {
  tenant: TenantRow & { planId: string | null; trialEndAt: string | null }
  owner: { accountId: string; staffId: string; attachedExistingAccount: boolean }
}
interface GoodsView {
  id: string
  name: string
  priceCents: number
  stock: number
  status: string
}
interface GoodsMutation {
  goods: GoodsView
}
interface BootstrapData {
  tenant: { id: string; slug: string; readonly: boolean; planExpireAt: string | null }
  permissions: string[]
}
interface PlanReadonlyPayload {
  reason: string
  phase: string
  daysLeft: number
  renewalPath: string
}
interface ShopClosedPayload {
  reason: string
  phase: string
}
interface SelfOrderResult {
  order: { id: string; outTradeNo: string; amountCents: number; status: string; planId: string }
  payParams: { provider: string; channel: string }
}
interface AuditRow {
  action: string
  actorType: string
  actorId: string
  targetType: string
  targetId: string
  after: Record<string, unknown> | null
  result: string
}

// ─── 断言小工具 ──────────────────────────────────────────────────────────────

/** 业务成功（`code === 0`），返回 `data`。失败信息带上完整的请求与响应体。 */
function ok<T>(res: Called<T>, what: string): T {
  expect(res.body.code, `${what}：期望业务成功（code=0），实际 ${res.body.code}${res.detail}`).toBe(
    0,
  )
  return res.body.data
}

/** 业务错误码必须**精确**等于期望值。「随便红一个」不算通过——错误码是对外契约。 */
function bizCode<T>(res: Called<T>, expected: number, what: string): T {
  expect(res.body.code, `${what}：期望业务码 ${expected}，实际 ${res.body.code}${res.detail}`).toBe(
    expected,
  )
  // 业务错误一律 HTTP 200 + 业务码（蓝图 §4.9）：走 4xx 就说明它变成了传输层错误，
  // 前端那句 `if (res.code !== 0)` 会拿不到。
  expect(res.status, `${what}：业务错误必须是 HTTP 200${res.detail}`).toBe(200)
  return res.body.data
}

/** JWT 载荷（不验签，只看内容——签名由服务端自己保证）。 */
function jwtPayload(token: string): Record<string, unknown> {
  const seg = token.split('.')[1] ?? ''
  const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  return JSON.parse(json) as Record<string, unknown>
}

/**
 * 轮询直到 `probe` 返回真值。
 *
 * 两处要用：`PlatformGateway` 对租户视图有 30s 缓存（⑧ 改完库不一定立刻生效），
 * 审计与站内信是**带外**写的（⑨ 的回调 200 之后那一行可能还没落库）。
 */
async function waitFor<T>(
  label: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const v = await probe()
      if (v !== undefined) return v
    } catch (e) {
      last = e
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}：${timeoutMs}ms 内没等到${last === undefined ? '' : `（最后一次：${String(last)}）`}`,
      )
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

/** 打一行「这条到底证明了什么」，让 `pnpm acceptance` 的输出自己就是一份验收记录。 */
function proved(line: string): void {
  console.log(`      [32m✓[0m ${line}`)
}

// ─── 现场 ────────────────────────────────────────────────────────────────────

let acc: Acceptance
const S = {
  platformToken: '',
  tenantAId: '',
  tenantBId: '',
  tenantBSlug: `acc-b-${Math.random().toString(36).slice(2, 8)}`,
  paidPlanId: '',
  staffTokenA: '',
  staffTokenB: '',
  memberToken: '',
  goodsIdB: '',
  outTradeNo: '',
  orderId: '',
  orderAmountCents: 0,
}

const GET = async <T>(p: string, token?: string): Promise<Called<T>> =>
  call<T>(acc.baseUrl, 'GET', p, { token })
const POST = async <T>(
  p: string,
  body: unknown,
  token?: string,
  headers?: Record<string, string>,
): Promise<Called<T>> => call<T>(acc.baseUrl, 'POST', p, { body, token, headers })
const PUT = async <T>(p: string, body: unknown, token?: string): Promise<Called<T>> =>
  call<T>(acc.baseUrl, 'PUT', p, { body, token })
const DEL = async <T>(p: string, token?: string): Promise<Called<T>> =>
  call<T>(acc.baseUrl, 'DELETE', p, { token })

describe('蓝图 §6 · 生成项目的 9 条验收断言', () => {
  beforeAll(async () => {
    acc = await setupAcceptance()
  })

  afterAll(async () => {
    await acc?.teardown()
  })

  // ───────────────────────────────────────────────────────────────────────────
  it('① 平台超管登录', async () => {
    const res = await POST<LoginData>('/api/platform/auth/login', PLATFORM_ADMIN)
    const data = ok(res, '① 平台超管登录')
    expect(data.access, `① 登录成功但没回 access${res.detail}`).toBeTruthy()
    S.platformToken = data.access

    // token 的 kind 必须是 platform：三套密钥独立、kind 互不通用（蓝图 §9 第 5 条）。
    expect(jwtPayload(data.access).kind, '① token 的 kind 不是 platform').toBe('platform')

    const me = await GET<{ id: string; kind: string }>('/api/platform/auth/me', S.platformToken)
    expect(ok(me, '① /api/platform/auth/me').kind).toBe('platform')

    proved('POST /api/platform/auth/login 拿到 platform kind 的 token，/auth/me 认得它')
  })

  // ───────────────────────────────────────────────────────────────────────────
  it('② 建租户 + 选套餐', async () => {
    const plans = await GET<Page<PlanRow>>('/api/platform/plans?pageSize=50', S.platformToken)
    const items = ok(plans, '② 套餐列表').items
    const paid = items.find((p) => p.code === PAID_PLAN_CODE)
    expect(
      paid,
      `② seed 里应当有 ${PAID_PLAN_CODE} 套餐，实到 ${items.map((p) => p.code).join(',')}`,
    ).toBeDefined()
    S.paidPlanId = paid!.id
    expect(paid!.firstPriceCents, '② 付费套餐的首购价必须非零（⑨ 要付一笔真金额）').toBeGreaterThan(
      0,
    )

    // 租户 A 的 id：③ ⑦ ⑧ 都要用。
    const tenants = await GET<Page<TenantRow>>('/api/platform/tenants?pageSize=50', S.platformToken)
    const a = ok(tenants, '② 租户列表').items.find((t) => t.slug === SHOP_A_SLUG)
    expect(a, `② seed 应当建出 slug=${SHOP_A_SLUG} 的租户`).toBeDefined()
    S.tenantAId = a!.id

    // 建租户：`attachExistingAccount` 把店主挂到已存在的账号上——一号多店，④ 才有得换。
    const res = await POST<CreateTenantResult>(
      '/api/platform/tenants',
      {
        slug: S.tenantBSlug,
        name: '验收租户 B',
        ownerPhone: OWNER.phone,
        attachExistingAccount: true,
        planId: S.paidPlanId,
        trialDays: 30,
      },
      S.platformToken,
    )
    const created = ok(res, '② 建租户')
    expect(res.status, `② 建租户应当是 HTTP 201${res.detail}`).toBe(201)
    expect(created.tenant.slug).toBe(S.tenantBSlug)
    expect(created.tenant.planId, '② 选的套餐没落到租户上').toBe(S.paidPlanId)
    expect(created.tenant.planExpireAt, '② 建完必须有到期时间，否则闸门无从算起').toBeTruthy()
    expect(created.owner.attachedExistingAccount, '② 应当挂到已存在的店主账号上').toBe(true)
    S.tenantBId = created.tenant.id

    // 建租户只有 @taizan/provision 一条路（架构 spec 14）：这里顺带验它真的把店主也建出来了。
    expect(created.owner.staffId, '② 建租户必须同时建出店主员工记录').toBeTruthy()

    proved(
      `POST /api/platform/tenants 建出 ${S.tenantBSlug}，套餐 ${PAID_PLAN_CODE} 与到期时间 ${created.tenant.planExpireAt} 都落库`,
    )
  })

  // ───────────────────────────────────────────────────────────────────────────
  it('③ 商家店主登录', async () => {
    // 一号两店：不指定 tenantId 时不发 token，先让前端选店。
    const choose = await POST<StaffSession>('/api/admin/auth/login', {
      phone: OWNER.phone,
      password: OWNER.password,
    })
    const chooseData = ok(choose, '③ 未指定门店的登录')
    expect(chooseData.needChooseShop, '③ 一号多店时必须先选店，不该直接发 token').toBe(true)
    expect(
      (chooseData as unknown as { access?: string }).access,
      '③ needChooseShop 的应答里绝不能带 token',
    ).toBeUndefined()
    expect(chooseData.shops.map((s) => s.tenantId).sort()).toEqual(
      [S.tenantAId, S.tenantBId].sort(),
    )

    const res = await POST<StaffSession>('/api/admin/auth/login', {
      phone: OWNER.phone,
      password: OWNER.password,
      tenantId: S.tenantAId,
    })
    const session = ok(res, '③ 店主登录')
    expect(session.needChooseShop).toBe(false)
    expect(session.tenantId).toBe(S.tenantAId)
    S.staffTokenA = session.access

    // 「token.tenantId 就是当前店」——蓝图 §9 第 5 条不变量。
    const payload = jwtPayload(session.access)
    expect(payload.kind, '③ token 的 kind 不是 staff').toBe('staff')
    expect(payload.tenantId, '③ token 里的 tenantId 必须就是当前店').toBe(S.tenantAId)

    const boot = ok(
      await GET<BootstrapData>('/api/admin/auth/bootstrap', S.staffTokenA),
      '③ bootstrap',
    )
    expect(boot.tenant.id).toBe(S.tenantAId)
    // 店主角色在库里是 `['*']`，但 bootstrap 下发的是**展开后的**具体清单
    // （前端按点判定，拿到一个 `*` 什么也做不了）。所以断言的是「后面几条要用的点都在」。
    expect(boot.permissions.length, '③ 店主的权限清单不该是空的').toBeGreaterThan(0)
    expect(boot.permissions, '③ 店主应当有示例模块的写权限（⑥ 要用）').toContain('goods:write')
    expect(boot.permissions, '③ 店主应当有下单续费的权限（⑧ 要用）').toContain('billing:order')

    proved(`POST /api/admin/auth/login 先选店后发 token；token.tenantId = ${S.tenantAId}`)
  })

  // ───────────────────────────────────────────────────────────────────────────
  it('④ 切换门店（重签 token）', async () => {
    const res = await POST<StaffSession>(
      '/api/admin/auth/switch',
      { tenantId: S.tenantBId },
      S.staffTokenA,
    )
    const session = ok(res, '④ 换店')
    S.staffTokenB = session.access

    expect(session.tenantId).toBe(S.tenantBId)
    expect(S.staffTokenB, '④ 换店必须重签一张新 token，不能沿用旧的').not.toBe(S.staffTokenA)

    const before = jwtPayload(S.staffTokenA)
    const after = jwtPayload(S.staffTokenB)
    expect(after.tenantId, '④ 新 token 的 tenantId 必须是目标店').toBe(S.tenantBId)
    expect(after.accountId, '④ 换店换的是店，不是人：accountId 不该变').toBe(before.accountId)
    expect(after.sub, '④ 每家店有各自的 staffId，sub 应当跟着换').not.toBe(before.sub)

    const bootB = ok(
      await GET<BootstrapData>('/api/admin/auth/bootstrap', S.staffTokenB),
      '④ 新 token 的 bootstrap',
    )
    expect(bootB.tenant.id).toBe(S.tenantBId)

    // 蓝图附录第 5 条决策：换店重签后**不主动吊销旧 token**（支持多标签各开一店，由 exp 兜底）。
    // 这是刻意行为，所以要断言它成立——哪天有人「顺手」加了吊销，这里会红。
    const bootA = ok(
      await GET<BootstrapData>('/api/admin/auth/bootstrap', S.staffTokenA),
      '④ 旧 token 的 bootstrap',
    )
    expect(bootA.tenant.id, '④ 旧 token 应当仍然指向原来那家店').toBe(S.tenantAId)

    proved(
      'POST /api/admin/auth/switch 重签出新 token（tenantId 换了、accountId 没换），旧 token 仍指向原店',
    )
  })

  // ───────────────────────────────────────────────────────────────────────────
  it('⑤ C 端会员登录', async () => {
    const res = await POST<{ access: string; tenantId: string; member: { phone: string } }>(
      '/api/client/auth/login-dev',
      { phone: MEMBER_PHONE },
      undefined,
      // `/api/client/*` 靠 slug/子域名定位租户，且**失败关闭**：不带就是 1240400。
      { 'x-tenant-slug': SHOP_A_SLUG },
    )
    const data = ok(res, '⑤ 会员登录')
    S.memberToken = data.access
    expect(data.tenantId).toBe(S.tenantAId)
    expect(data.member.phone).toBe(MEMBER_PHONE)
    expect(jwtPayload(data.access).kind, '⑤ token 的 kind 不是 member').toBe('member')

    // 会员 token 在 C 端能读到本店在架商品。
    const list = ok(
      await GET<Page<GoodsView>>('/api/client/goods', S.memberToken),
      '⑤ C 端商品列表',
    )
    expect(
      list.items.every((g) => g.status === 'ON_SHELF'),
      '⑤ C 端只应看到在架商品',
    ).toBe(true)

    // 反面：不带租户线索的 C 端请求必须失败关闭。
    const noTenant = await call(acc.baseUrl, 'GET', '/api/client/goods')
    expect([1240400, 1140100], `⑤ 无租户无身份的 C 端请求必须被挡${noTenant.detail}`).toContain(
      noTenant.body.code,
    )

    proved(
      `POST /api/client/auth/login-dev（X-Tenant-Slug: ${SHOP_A_SLUG}）拿到 member token 并读到在架商品`,
    )
  })

  // ───────────────────────────────────────────────────────────────────────────
  it('⑥ 示例 CRUD 增删改查全通', async () => {
    const name = `验收商品-${Date.now()}`

    const created = ok(
      await POST<GoodsMutation>(
        '/api/admin/goods',
        { name, priceCents: 1234, stock: 5, status: 'ON_SHELF' },
        S.staffTokenA,
      ),
      '⑥ 新增',
    )
    const id = created.goods.id
    expect(created.goods).toMatchObject({ name, priceCents: 1234, stock: 5, status: 'ON_SHELF' })

    const list = ok(
      await GET<Page<GoodsView>>('/api/admin/goods?page=1&pageSize=200', S.staffTokenA),
      '⑥ 列表',
    )
    expect(
      list.items.map((g) => g.id),
      '⑥ 列表里应当有刚建的那条',
    ).toContain(id)
    expect(list.total).toBeGreaterThan(0)

    const detail = ok(await GET<GoodsView>(`/api/admin/goods/${id}`, S.staffTokenA), '⑥ 详情')
    expect(detail).toMatchObject({ id, name, priceCents: 1234 })
    expect(
      (detail as unknown as Record<string, unknown>).tenantId,
      '⑥ 对外视图不该把 tenantId 漏出去',
    ).toBeUndefined()

    const updated = ok(
      await PUT<GoodsMutation>(
        `/api/admin/goods/${id}`,
        { priceCents: 4321, stock: 9 },
        S.staffTokenA,
      ),
      '⑥ 修改',
    )
    expect(updated.goods).toMatchObject({ id, priceCents: 4321, stock: 9, name })

    const removed = ok(await DEL<{ id: string }>(`/api/admin/goods/${id}`, S.staffTokenA), '⑥ 删除')
    expect(removed.id).toBe(id)

    // 软删之后立刻查不到——软删要是没接管读路径，这条会绿着放过一个真 bug。
    const gone = await GET<GoodsView>(`/api/admin/goods/${id}`, S.staffTokenA)
    expect(gone.body.code, `⑥ 删除后再查应当查不到${gone.detail}`).not.toBe(0)
    const listAfter = ok(
      await GET<Page<GoodsView>>('/api/admin/goods?page=1&pageSize=200', S.staffTokenA),
      '⑥ 删除后的列表',
    )
    expect(
      listAfter.items.map((g) => g.id),
      '⑥ 删除后列表里不该还有它',
    ).not.toContain(id)

    proved('POST / GET 列表 / GET 详情 / PUT / DELETE 全通，软删后读路径立刻看不到')
  })

  // ───────────────────────────────────────────────────────────────────────────
  it('⑦ 租户 A 的 token 访问租户 B 的资源返回 1240300', async () => {
    // 先用 B 的 token 在 B 店建一条，作为对照物。
    const gb = ok(
      await POST<GoodsMutation>(
        '/api/admin/goods',
        { name: `B 店商品-${Date.now()}`, priceCents: 999 },
        S.staffTokenB,
      ),
      '⑦ 在租户 B 建商品',
    )
    S.goodsIdB = gb.goods.id

    const CODE = 1240300
    bizCode(await GET(`/api/admin/goods/${S.goodsIdB}`, S.staffTokenA), CODE, '⑦ A 读 B 的商品')
    bizCode(
      await PUT(`/api/admin/goods/${S.goodsIdB}`, { priceCents: 1 }, S.staffTokenA),
      CODE,
      '⑦ A 改 B 的商品',
    )
    bizCode(await DEL(`/api/admin/goods/${S.goodsIdB}`, S.staffTokenA), CODE, '⑦ A 删 B 的商品')

    // 列表也看不到（隔离不能只做在按 id 取的那条路径上）。
    const list = ok(
      await GET<Page<GoodsView>>('/api/admin/goods?page=1&pageSize=200', S.staffTokenA),
      '⑦ A 的商品列表',
    )
    expect(
      list.items.map((g) => g.id),
      '⑦ A 的列表里不该出现 B 的商品',
    ).not.toContain(S.goodsIdB)

    // 伪造租户线索不该有任何效果：token 里的 tenantId 优先级最高（TokenTenantResolver）。
    const spoof = await call<Page<GoodsView>>(
      acc.baseUrl,
      'GET',
      `/api/admin/goods?tenantId=${S.tenantBId}&pageSize=200`,
      {
        token: S.staffTokenA,
        headers: { 'x-tenant-id': S.tenantBId, 'x-tenant-slug': S.tenantBSlug },
      },
    )
    const spoofed = ok(spoof, '⑦ 带伪造租户头的列表')
    expect(
      spoofed.items.map((g) => g.id),
      '⑦ 伪造 X-Tenant-Id 不该越权',
    ).not.toContain(S.goodsIdB)

    // B 自己读得到——证明上面三条 1240300 不是因为「这条数据根本不存在」。
    expect(
      ok(await GET<GoodsView>(`/api/admin/goods/${S.goodsIdB}`, S.staffTokenB), '⑦ B 读自己的商品')
        .id,
    ).toBe(S.goodsIdB)

    proved('A 的 token 对 B 的资源读/改/删一律 1240300，列表与伪造租户头也越不过去；B 自己读得到')
  })

  // ───────────────────────────────────────────────────────────────────────────
  it('⑧ planExpireAt 改成昨天：后台写 1440301、/api/admin/billing 仍可写、C 端 1440302', async () => {
    // 平台侧只有「续期」（往后推），没有把到期时间往前调的接口——蓝图这一条的原话就是
    // 「把 planExpireAt 改成昨天」，所以这里直接改库。这是全文件唯一一处不走 HTTP 的动作。
    // trialEndAt 置空 + graceDays 归零：否则试用期或宽限期会把闸门顶开，测的就不是「到期」了。
    await acc.sql(
      `UPDATE Tenant SET planExpireAt = DATE_SUB(NOW(), INTERVAL 1 DAY), trialEndAt = NULL, ` +
        `graceDays = 0, status = 'ACTIVE' WHERE id = '${S.tenantAId}';`,
    )

    // PlatformGateway 对租户视图有 30s 缓存，改完库不一定立刻生效——轮询而不是 sleep 固定秒数。
    const blocked = await waitFor(
      '⑧ 等待闸门生效（PlatformGateway 缓存 30s）',
      45_000,
      async () => {
        const r = await POST<PlanReadonlyPayload>(
          '/api/admin/goods',
          { name: `到期后不该建成-${Date.now()}`, priceCents: 100 },
          S.staffTokenA,
        )
        return r.body.code === 1440301 ? r : undefined
      },
    )
    const payload = bizCode(blocked, 1440301, '⑧ 到期后写后台')
    expect(payload.reason).toBe('EXPIRED')
    expect(payload.phase).toBe('EXPIRED')
    expect(payload.daysLeft, '⑧ 已经到期，daysLeft 必须为负').toBeLessThan(0)
    // 「到期 → 只读 → 续不了费 → 永远到期」的出口必须写在错误体里，前端才知道往哪跳。
    expect(payload.renewalPath, '⑧ 只读错误必须带续费入口').toBe('/api/admin/billing')

    // 读不受影响：只读的意思是只读，不是关站。
    ok(await GET<Page<GoodsView>>('/api/admin/goods?pageSize=1', S.staffTokenA), '⑧ 到期后读后台')

    // 续费路径永远可写（ALWAYS_WRITABLE_PREFIXES）。这一条是 ⑧ 的重点：
    // 只断言「写不了」而不断言「还能续费」，守不住那个死循环。
    const overview = ok(
      await GET<{ readonly: boolean; phase: string }>('/api/admin/billing', S.staffTokenA),
      '⑧ /api/admin/billing 概览',
    )
    expect(overview.readonly, '⑧ 概览应当自报只读').toBe(true)
    expect(overview.phase).toBe('EXPIRED')

    const order = ok(
      await POST<SelfOrderResult>(
        '/api/admin/billing/orders',
        { planId: S.paidPlanId, periods: 1 },
        S.staffTokenA,
      ),
      '⑧ 到期后下续费单（/api/admin/billing 必须仍可写）',
    )
    expect(order.order.status).toBe('PENDING')
    expect(order.order.amountCents, '⑧ 续费单金额必须非零').toBeGreaterThan(0)
    expect(order.payParams.provider, '⑧ PAY_FAKE_ENABLED=true 时应当走 FakeProvider').toBe('FAKE')
    S.orderId = order.order.id
    S.outTradeNo = order.order.outTradeNo
    S.orderAmountCents = order.order.amountCents

    // 换店接口也在白名单里：到期了还得能切到别的店去（否则一号多店的人会被一家过期店卡死）。
    ok(
      await POST<StaffSession>('/api/admin/auth/switch', { tenantId: S.tenantAId }, S.staffTokenA),
      '⑧ 到期后 /api/admin/auth 仍可写',
    )

    // C 端：另一个错误码、另一套文案（对顾客不提「续费/欠费」）。
    const closed = bizCode<ShopClosedPayload>(
      await GET('/api/client/goods', S.memberToken),
      1440302,
      '⑧ 到期后的 C 端',
    )
    expect(closed.reason).toBe('EXPIRED')

    proved(
      `到期后：后台写 1440301（renewalPath=/api/admin/billing）、后台读仍 0、` +
        `/api/admin/billing 下单 ${S.orderAmountCents} 分成功、C 端 1440302`,
    )
  })

  // ───────────────────────────────────────────────────────────────────────────
  it('⑨ Fake 支付回调：租户自动续期 + AuditLog 有记录', async () => {
    const before = ok(
      await GET<BootstrapData>('/api/admin/auth/bootstrap', S.staffTokenA),
      '⑨ 付款前的 bootstrap',
    )
    expect(before.tenant.readonly, '⑨ 付款前应当还是只读').toBe(true)

    // 回调报文与 FakeProvider.simulateCallback 逐字节一致（验签验的是原始字节，
    // 键序或空白差一点都会验签失败——这也正是 main.ts 必须 `rawBody: true` 的原因）。
    const transactionId = `FAKETXN-${S.orderId}`
    const body = JSON.stringify({
      eventType: 'TRANSACTION.SUCCESS',
      channel: 'WECHAT',
      outTradeNo: S.outTradeNo,
      transactionId,
      amountCents: S.orderAmountCents,
      paidAt: new Date().toISOString(),
      payer: { kind: 'none' },
    })
    const signature = createHmac('sha256', FAKE_SECRET).update(body, 'utf8').digest('hex')

    const notify = await fetch(`${acc.baseUrl}/api/public/pay/wechat/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [FAKE_SIG_HEADER]: signature,
        'x-forwarded-for': '10.99.0.1',
      },
      body,
    })
    const ackText = await notify.text()
    const ackDetail = `\n  请求  POST /api/public/pay/wechat/notify ${body}\n  响应  HTTP ${notify.status} ${ackText}`
    expect(notify.status, `⑨ 回调应答必须 200，否则支付渠道会一直重推${ackDetail}`).toBe(200)
    // 回调路由是 @RawResponse()：应答的是渠道要的报文，不是 {code,message,data} 信封。
    expect(JSON.parse(ackText), `⑨ 回调应答报文不对${ackDetail}`).toEqual({
      code: 'SUCCESS',
      message: '成功',
    })

    // 兑现是带外做的（事务提交后才 invalidate 缓存 + 写审计 + 发站内信）。
    const after = await waitFor('⑨ 等待租户续期生效', 30_000, async () => {
      const r = await GET<BootstrapData>('/api/admin/auth/bootstrap', S.staffTokenA)
      const d = r.body.data
      return r.body.code === 0 && !d.tenant.readonly ? d : undefined
    })
    expect(after.tenant.readonly, '⑨ 付完款应当解除只读').toBe(false)
    expect(after.tenant.planExpireAt, '⑨ 续期后必须有到期时间').toBeTruthy()
    expect(
      new Date(after.tenant.planExpireAt as string).getTime(),
      `⑨ 续期后的到期时间必须在未来（实际 ${after.tenant.planExpireAt}）`,
    ).toBeGreaterThan(Date.now())

    // 「解除只读」不是纸面状态：真的再写一次。
    const reopened = ok(
      await POST<GoodsMutation>(
        '/api/admin/goods',
        { name: `续期后可写-${Date.now()}`, priceCents: 11 },
        S.staffTokenA,
      ),
      '⑨ 续期后重新可写',
    )
    expect(reopened.goods.id).toBeTruthy()

    // AuditLog：钱变成权益这件事必须留痕，且 actor 是回调而不是某个人。
    const audit = await waitFor('⑨ 等待 AuditLog 落库', 20_000, async () => {
      const r = await GET<Page<AuditRow>>(
        '/api/admin/audit-logs?action=plan-order.fulfill&pageSize=20',
        S.staffTokenA,
      )
      return r.body.code === 0 && r.body.data.items.length > 0 ? r.body.data : undefined
    })
    expect(audit.items.length, '⑨ 一笔订单只该留一条兑现审计').toBe(1)
    const row = audit.items[0]!
    expect(row.action).toBe('plan-order.fulfill')
    expect(row.result).toBe('SUCCESS')
    expect(row.actorType, '⑨ 回调兑现的 actor 是系统，不是人').toBe('SYSTEM')
    expect(row.actorId).toBe('pay-callback')
    expect(row.targetType).toBe('PlanOrder')
    expect(row.targetId).toBe(S.orderId)
    expect(row.after, '⑨ 审计必须记下续期前后的到期时间，对账时要靠它').toMatchObject({
      via: 'CALLBACK',
      outTradeNo: S.outTradeNo,
      transactionId,
      amountCents: S.orderAmountCents,
    })

    // 幂等：渠道重推同一条不该再兑现一次（transactionId 是幂等键）。
    const again = await fetch(`${acc.baseUrl}/api/public/pay/wechat/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [FAKE_SIG_HEADER]: signature,
        'x-forwarded-for': '10.99.0.2',
      },
      body,
    })
    expect(again.status, '⑨ 重复回调也要应答 200').toBe(200)
    const auditAgain = ok(
      await GET<Page<AuditRow>>(
        '/api/admin/audit-logs?action=plan-order.fulfill&pageSize=20',
        S.staffTokenA,
      ),
      '⑨ 重复回调后的审计',
    )
    expect(auditAgain.items.length, '⑨ 重复回调不该产生第二条兑现记录').toBe(1)

    proved(
      `Fake 回调 → 租户续期至 ${after.tenant.planExpireAt}、后台恢复可写、` +
        `AuditLog 留下一条 plan-order.fulfill（重复推送不重复兑现）`,
    )
  })
})
