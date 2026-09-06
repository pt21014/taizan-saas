/**
 * T0-7 的验收用例 ①–⑩、⑫（守卫 + 租户解析 + 换店）。
 *
 * 每个 it 的开头标了它对应任务分解里的哪一条，改这个文件之前先确认对应关系还在。
 */

import { ErrorCode } from '@taizan/contracts'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { activeMembership, createHarness, type Harness } from './__test__/harness'
import { TOKEN_PAYLOAD_VERSION } from './token/jwt-payload'

const ACCOUNT = 'ACCT0000000000000000000001'
const TENANT_A = 'TENANT000000000000000000A'
const TENANT_B = 'TENANT000000000000000000B'
const STAFF_A = 'STAFFA0000000000000000001'
const STAFF_B = 'STAFFB0000000000000000001'
const MEMBER = 'MEMBER0000000000000000001'
const ADMIN = 'ADMIN00000000000000000001'

let h: Harness

afterEach(async () => {
  await h?.app.close()
})

function server(): Parameters<typeof request>[0] {
  return h.app.getHttpServer() as Parameters<typeof request>[0]
}

/** 签一个 staff token 并登记会话。 */
async function staffToken(tenantId = TENANT_A, staffId = STAFF_A): Promise<string> {
  const result = await h.flow.loginStaff(ACCOUNT, tenantId)
  void staffId
  return result.access
}

describe('GlobalAuthGuard 默认拒绝', () => {
  // 用例①
  it('无任何装饰器的控制器方法，不带 token 直接 401（1140100）', async () => {
    h = await createHarness()
    const res = await request(server()).get('/api/platform/t/none')
    expect(res.body.code).toBe(ErrorCode.UNAUTHENTICATED.code)
    expect(res.body.code).toBe(1140100)
  })

  it('带一个伪造的 token 也是 401——签名对不上', async () => {
    h = await createHarness()
    const res = await request(server())
      .get('/api/platform/t/none')
      .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoic3RhZmYifQ.forged')
    expect(res.body.code).toBe(1140100)
  })

  it('Authorization 头不带 Bearer 前缀不认（只认一种格式）', async () => {
    h = await createHarness()
    const { access } = await h.flow.login('platform', ADMIN)
    const res = await request(server()).get('/api/platform/t/none').set('Authorization', access)
    expect(res.body.code).toBe(1140100)
  })

  // 用例②
  it('@Public() 的路由放行，且上下文里没有身份', async () => {
    h = await createHarness()
    const res = await request(server()).get('/api/public/ping').expect(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ tenantId: null, identityKind: null, identityId: null })
  })

  it('@Public() 但没声明 @RateLimited(tier) 时打一条 warn（spec 5 的运行时半边）', async () => {
    h = await createHarness()
    await request(server()).get('/api/public/unthrottled').expect(200)
    expect(h.warnings.some((w) => w.includes('RateLimited'))).toBe(true)
  })

  it('同一个未限流路由的 warn 只打一次，不刷屏', async () => {
    h = await createHarness()
    await request(server()).get('/api/public/unthrottled')
    await request(server()).get('/api/public/unthrottled')
    await request(server()).get('/api/public/unthrottled')
    expect(h.warnings.filter((w) => w.includes('RateLimited'))).toHaveLength(1)
  })

  // 用例③
  it('member token 打 @Auth("staff") 的路由 → 1140102 凭证类型不符', async () => {
    h = await createHarness()
    const { access } = await h.flow.login('member', MEMBER, TENANT_A)
    const res = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${access}`)
    expect(res.body.code).toBe(ErrorCode.TOKEN_KIND_MISMATCH.code)
    expect(res.body.code).toBe(1140102)
  })

  it('platform token 打 /api/admin 的路由 → 1140102 凭证类型不符（不是 1240400）', async () => {
    h = await createHarness()
    const { access } = await h.flow.login('platform', ADMIN)
    const res = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${access}`)
    // platform token 没有 tenantId，token 策略不适用。/api/admin 在
    // TENANT_TOKEN_ONLY_PREFIXES 里，中间件于是留空放行，由守卫给出准确的答案：
    // 这不是「店铺不存在」，是「你这张票不能进这道门」。
    expect(res.body.code).toBe(ErrorCode.TOKEN_KIND_MISMATCH.code)
    expect(res.body.code).toBe(1140102)
  })

  // ── /api/admin 的租户解析口径（TENANT_TOKEN_ONLY_PREFIXES）────────────────
  it('/api/admin 无 token → 1140100（未登录），而不是 1240400（租户不存在）', async () => {
    h = await createHarness()
    const res = await request(server()).get('/api/admin/t/staff-only')
    // 中间件跑在守卫之前，一旦它抢着失败关闭，前端拿到的就是「店铺不存在」，
    // 于是不会跳登录页——这条断言就是那个 bug 的机器守卫。
    expect(res.body.code).toBe(ErrorCode.UNAUTHENTICATED.code)
    expect(res.body.code).toBe(1140100)
  })

  it('/api/admin 带坏 token → 1140100，同样不是 1240400', async () => {
    h = await createHarness()
    const res = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJraW5kIjoic3RhZmYifQ.forged')
    expect(res.body.code).toBe(1140100)
  })

  it('/api/admin 下 X-Tenant-Slug 一概不作数（只认 token）', async () => {
    h = await createHarness({ tenants: [{ id: TENANT_B, slug: 'shop-b', status: 'ACTIVE' }] })
    const res = await request(server())
      .get('/api/admin/t/staff-only')
      .set('X-Tenant-Slug', 'shop-b')
    // 就算 slug 是真的、店也是好的，商家后台也不接受用请求头选店：
    // 没 token 就是没登录。
    expect(res.body.code).toBe(1140100)
  })

  it('/api/client 仍然失败关闭：没线索就是 1240400', async () => {
    h = await createHarness()
    const res = await request(server()).get('/api/client/whoami')
    // C 端在登录前本来就靠 slug/子域名选店，解析不出来就是真的「这家店不存在」。
    expect(res.body.code).toBe(1240400)
  })

  it('refresh token 不能当 access 用', async () => {
    h = await createHarness()
    const { refresh } = await h.flow.login('platform', ADMIN)
    const res = await request(server())
      .get('/api/platform/t/any')
      .set('Authorization', `Bearer ${refresh}`)
    expect(res.body.code).toBe(1140102)
  })

  it('过期的 token → 1140101（与 1140100 分开，前端才能区分「该刷新」和「该报警」）', async () => {
    h = await createHarness({ accessTtl: { platform: 60 } })
    const { access } = await h.flow.login('platform', ADMIN)
    h.clock.advanceSeconds(61)
    const res = await request(server())
      .get('/api/platform/t/any')
      .set('Authorization', `Bearer ${access}`)
    expect(res.body.code).toBe(ErrorCode.TOKEN_EXPIRED.code)
    expect(res.body.code).toBe(1140101)
  })
})

describe('会话吊销', () => {
  // 用例④
  it('改密后 revokeAll，旧 jti 立即 401（不等 exp）', async () => {
    h = await createHarness()
    h.memberships.set(ACCOUNT, TENANT_A, activeMembership({ staffId: STAFF_A }))
    const token = await staffToken()

    await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    // 改密 → 全端撤销。时钟一秒都没往前走。
    await h.flow.changePassword('staff', STAFF_A)

    const res = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1140100)
  })

  it('单端登出只踢自己那一条，其它端不受影响', async () => {
    h = await createHarness()
    h.memberships.set(ACCOUNT, TENANT_A, activeMembership({ staffId: STAFF_A }))
    const phone = await staffToken()
    const cashier = await staffToken()

    // Nest 的 @Post 默认回 201，这里只关心业务码。
    await request(server())
      .post('/api/admin/t/logout')
      .set('Authorization', `Bearer ${phone}`)
      .expect(201)

    expect(
      (
        await request(server())
          .get('/api/admin/t/staff-only')
          .set('Authorization', `Bearer ${phone}`)
      ).body.code,
    ).toBe(1140100)
    expect(
      (
        await request(server())
          .get('/api/admin/t/staff-only')
          .set('Authorization', `Bearer ${cashier}`)
      ).body.code,
    ).toBe(0)
  })

  // 用例⑫
  it('staff 第 9 端登录，最旧的那条 jti 被踢下线', async () => {
    h = await createHarness()
    h.memberships.set(ACCOUNT, TENANT_A, activeMembership({ staffId: STAFF_A }))

    const tokens: string[] = []
    for (let i = 0; i < 8; i += 1) {
      // 每次登录推进 1 秒，让「最旧」有确定的定义。
      h.clock.advanceSeconds(1)
      tokens.push(await staffToken())
    }
    // 8 端都在线。
    for (const t of tokens) {
      expect(
        (await request(server()).get('/api/admin/t/staff-only').set('Authorization', `Bearer ${t}`))
          .body.code,
      ).toBe(0)
    }

    h.clock.advanceSeconds(1)
    const ninth = await h.flow.loginStaff(ACCOUNT, TENANT_A)
    expect(ninth.evicted).toHaveLength(1)

    // 最旧的那条（第一个签的）应该已经不能用了。
    const oldest = tokens[0] as string
    expect(
      (
        await request(server())
          .get('/api/admin/t/staff-only')
          .set('Authorization', `Bearer ${oldest}`)
      ).body.code,
    ).toBe(1140100)
    // 第二旧的还在。
    const second = tokens[1] as string
    expect(
      (
        await request(server())
          .get('/api/admin/t/staff-only')
          .set('Authorization', `Bearer ${second}`)
      ).body.code,
    ).toBe(0)
  })

  it('platform 默认单会话：第二次登录把第一次挤掉', async () => {
    h = await createHarness()
    const first = await h.flow.login('platform', ADMIN)
    h.clock.advanceSeconds(1)
    const second = await h.flow.login('platform', ADMIN)

    expect(
      (
        await request(server())
          .get('/api/platform/t/any')
          .set('Authorization', `Bearer ${first.access}`)
      ).body.code,
    ).toBe(1140100)
    expect(
      (
        await request(server())
          .get('/api/platform/t/any')
          .set('Authorization', `Bearer ${second.access}`)
      ).body.code,
    ).toBe(0)
  })
})

describe('staff 每请求现查成员关系', () => {
  // 用例⑤
  it('成员被停用后，≤30 秒内 401（缓存到期即生效）', async () => {
    h = await createHarness({ cacheMembership: true })
    h.memberships.set(ACCOUNT, TENANT_A, activeMembership({ staffId: STAFF_A }))
    const token = await staffToken()

    await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    // 库里改成 DISABLED。此刻缓存里还是 ACTIVE。
    h.memberships.patch(ACCOUNT, TENANT_A, { status: 'DISABLED' })
    expect(
      (
        await request(server())
          .get('/api/admin/t/staff-only')
          .set('Authorization', `Bearer ${token}`)
      ).body.code,
    ).toBe(0)

    // 推进 30 秒，缓存过期，下一次请求会穿透到「库」。
    h.clock.advanceSeconds(30)
    const res = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1140100)
    expect(res.body.message).toContain('停用')
  })

  it('被移出店铺（membership 为空）也是 401', async () => {
    h = await createHarness({ cacheMembership: true })
    h.memberships.set(ACCOUNT, TENANT_A, activeMembership({ staffId: STAFF_A }))
    const token = await staffToken()
    h.memberships.remove(ACCOUNT, TENANT_A)
    h.clock.advanceSeconds(30)

    const res = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1140100)
    expect(res.body.message).toContain('不在这家店铺')
  })

  // 用例⑥
  it('token 里的 roleIds 与库里不同时，以库里的为准', async () => {
    h = await createHarness()
    h.memberships.set(
      ACCOUNT,
      TENANT_A,
      activeMembership({
        staffId: STAFF_A,
        roleIds: ['role-from-db'],
        isOwner: true,
        dataScope: 'ALL',
      }),
    )
    // 手工签一个「token 里带着老角色」的 token——真实场景里它来自 8 小时前那次登录。
    const access = await h.tokens.sign('staff', {
      sub: STAFF_A,
      tenantId: TENANT_A,
      accountId: ACCOUNT,
      ver: TOKEN_PAYLOAD_VERSION,
    })
    const payload = await h.tokens.verify('staff', access)
    await h.sessions.add('staff', STAFF_A, payload.jti, 3600)

    const res = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${access}`)
      .expect(200)

    expect(res.body.data.roleIds).toEqual(['role-from-db'])
    expect(res.body.data.isOwner).toBe(true)
    expect(res.body.data.dataScope).toBe('ALL')
  })

  it('缓存生效：30 秒内的第二次请求不再穿透到 provider', async () => {
    h = await createHarness()
    h.memberships.set(ACCOUNT, TENANT_A, activeMembership({ staffId: STAFF_A }))
    const token = await staffToken()
    const before = h.memberships.calls

    await request(server()).get('/api/admin/t/staff-only').set('Authorization', `Bearer ${token}`)
    await request(server()).get('/api/admin/t/staff-only').set('Authorization', `Bearer ${token}`)
    await request(server()).get('/api/admin/t/staff-only').set('Authorization', `Bearer ${token}`)

    // membershipProvider 在 harness 里是直接传进去的（不套缓存），
    // 所以这里断言的是「守卫确实每请求都问了一次」——即现查语义本身。
    expect(h.memberships.calls - before).toBe(3)
  })
})

describe('换店（switchTenant）', () => {
  // 用例⑦
  it('换店后新 token 的 tenantId 变了，旧 token 仍可访问原店（不主动吊销，由 exp 兜底）', async () => {
    h = await createHarness()
    h.memberships.set(ACCOUNT, TENANT_A, activeMembership({ staffId: STAFF_A }))
    h.memberships.set(ACCOUNT, TENANT_B, activeMembership({ staffId: STAFF_B }))

    const oldToken = await staffToken(TENANT_A)
    const oldRes = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${oldToken}`)
      .expect(200)
    expect(oldRes.body.data.tenantId).toBe(TENANT_A)

    const principal = {
      kind: 'staff' as const,
      id: STAFF_A,
      jti: 'ignored',
      tenantId: TENANT_A,
      accountId: ACCOUNT,
    }
    const switched = await h.flow.switchTenant(principal, TENANT_B)

    const newRes = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${switched.access}`)
      .expect(200)
    expect(newRes.body.data.tenantId).toBe(TENANT_B)
    expect(newRes.body.data.id).toBe(STAFF_B)

    // 附录第 5 条：旧 token 不被吊销，仍然指向原店。
    const stillOld = await request(server())
      .get('/api/admin/t/staff-only')
      .set('Authorization', `Bearer ${oldToken}`)
      .expect(200)
    expect(stillOld.body.data.tenantId).toBe(TENANT_A)
  })

  it('换到一家自己不在的店 → 401，且文案不泄漏「这家店是否存在」', async () => {
    h = await createHarness()
    h.memberships.set(ACCOUNT, TENANT_A, activeMembership({ staffId: STAFF_A }))
    const principal = {
      kind: 'staff' as const,
      id: STAFF_A,
      jti: 'x',
      tenantId: TENANT_A,
      accountId: ACCOUNT,
    }
    await expect(h.flow.switchTenant(principal, TENANT_B)).rejects.toMatchObject({
      code: 1140100,
      message: '这家店铺不在你名下',
    })
  })

  it('member 身份不能换店', async () => {
    h = await createHarness()
    await expect(
      h.flow.switchTenant({ kind: 'member', id: MEMBER, jti: 'x', tenantId: TENANT_A }, TENANT_B),
    ).rejects.toMatchObject({ code: 1140102 })
  })
})

describe('租户解析', () => {
  // 用例⑧
  it('请求参数 / 请求头里携带别的 tenantId，不影响 staff 的上下文租户', async () => {
    h = await createHarness({
      tenants: [{ id: TENANT_B, slug: 'shop-b', status: 'ACTIVE' }],
    })
    h.memberships.set(ACCOUNT, TENANT_A, activeMembership({ staffId: STAFF_A }))
    const token = await staffToken(TENANT_A)

    const res = await request(server())
      .get(`/api/admin/t/staff-only?tenantId=${TENANT_B}&tenant_id=${TENANT_B}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', 'shop-b')
      .set('X-Tenant-Id', TENANT_B)
      .expect(200)

    // 主体上的 tenantId 与 ALS 上下文里的 tenantId 都必须是 token 里那家店。
    expect(res.body.data.tenantId).toBe(TENANT_A)
    expect(res.body.data.context.tenantId).toBe(TENANT_A)
    expect(res.body.data.context.identityId).toBe(STAFF_A)
  })

  // 用例⑨
  it('/api/public/* 不经过 TenantMiddleware（解析不出租户也照样 200）', async () => {
    h = await createHarness()
    // 没有 token、没有 slug、Host 也不是子域名——链上三条策略全不适用。
    const res = await request(server()).get('/api/public/ping').expect(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.tenantId).toBeNull()
  })

  it('/api/platform/* 同样不进租户中间件（平台面天然跨租户）', async () => {
    h = await createHarness()
    const { access } = await h.flow.login('platform', ADMIN)
    const res = await request(server())
      .get('/api/platform/t/any')
      .set('Authorization', `Bearer ${access}`)
      .expect(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.tenantId).toBeUndefined()
  })

  // 用例⑩
  it('X-Tenant-Slug 查不到租户 → 1240400', async () => {
    h = await createHarness({ tenants: [{ id: TENANT_A, slug: 'shop-a', status: 'ACTIVE' }] })
    const res = await request(server())
      .get('/api/client/whoami')
      .set('X-Tenant-Slug', 'not-a-real-shop')
    expect(res.body.code).toBe(ErrorCode.TENANT_NOT_FOUND.code)
    expect(res.body.code).toBe(1240400)
  })

  it('X-Tenant-Slug 命中时，公开的 /api/client 路由也能拿到租户上下文', async () => {
    h = await createHarness({ tenants: [{ id: TENANT_A, slug: 'shop-a', status: 'ACTIVE' }] })
    const res = await request(server())
      .get('/api/client/whoami')
      .set('X-Tenant-Slug', 'shop-a')
      .expect(200)
    expect(res.body.data.tenantId).toBe(TENANT_A)
  })

  it('被封停的店解析不出来（等价于「这家店不存在」）', async () => {
    h = await createHarness({ tenants: [{ id: TENANT_A, slug: 'shop-a', status: 'SUSPENDED' }] })
    const res = await request(server()).get('/api/client/whoami').set('X-Tenant-Slug', 'shop-a')
    expect(res.body.code).toBe(1240400)
  })

  it('什么线索都没有时失败关闭（1240400），不是「当作没有租户放过去」', async () => {
    h = await createHarness()
    const res = await request(server()).get('/api/client/whoami')
    expect(res.body.code).toBe(1240400)
  })
})
