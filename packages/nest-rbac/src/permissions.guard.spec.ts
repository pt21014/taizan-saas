/**
 * T1-2 的验收用例 ①②④⑤⑥（`PermissionsGuard` + 角色缓存）。
 *
 * 每个 describe 的开头标了它对应任务分解里的哪一条，改这个文件之前先确认对应关系还在。
 */

import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { activeMembership, createHarness, type Harness } from './__test__/harness'
import { RBAC_ERRORS } from './errors'
import { ROLE_CACHE_TTL_MS } from './role-permissions.service'

const ACCOUNT = 'ACCT0000000000000000000001'
const TENANT = 'TENANT000000000000000000A'
const STAFF = 'STAFF00000000000000000001'
const MEMBER = 'MEMBER0000000000000000001'
const ADMIN = 'ADMIN00000000000000000001'

const ROLE_LIST_ONLY = 'ROLE00000000000000000LIST'
const ROLE_WRITE = 'ROLE0000000000000000WRITE'
const ROLE_WILDCARD = 'ROLE0000000000000000CARD1'

let h: Harness

afterEach(async () => {
  await h?.app.close()
})

function server(): Parameters<typeof request>[0] {
  return h.app.getHttpServer() as Parameters<typeof request>[0]
}

/** 登录一个 staff 并拿 access token。 */
async function staffToken(
  membership: Partial<Parameters<typeof activeMembership>[0]> = {},
): Promise<string> {
  h.memberships.set(ACCOUNT, TENANT, activeMembership({ staffId: STAFF, ...membership }))
  const { access } = await h.flow.loginStaff(ACCOUNT, TENANT)
  return access
}

describe('用例①：staff 只含 goods:list 的角色', () => {
  it('访问 @RequirePermission("goods:write") 的路由 → 1340300', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list'] }] })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })

    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(RBAC_ERRORS.FORBIDDEN.code)
    expect(res.body.code).toBe(1340300)
  })

  it('1340300 的 HTTP 语义段是 403（前端只提示不登出），与 1140100 分流不同', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list'] }] })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(Math.floor((res.body.code % 100000) / 100)).toBe(403)
  })

  it('访问 goods:list 路由通过', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list'] }] })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })

    const res = await request(server())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
    expect(res.body.data).toEqual({ ok: true })
  })

  it('或表达式：只要命中一边就通过', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list'] }] })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })
    const res = await request(server())
      .get('/api/admin/goods/either')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('与表达式：缺一个就拒', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list'] }] })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })
    const res = await request(server())
      .get('/api/admin/goods/both')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1340300)
  })

  it('多角色取并集：两个角色各给一半，与表达式就过了', async () => {
    h = await createHarness({
      roles: [
        { id: ROLE_LIST_ONLY, permissionCodes: ['goods:list'] },
        { id: ROLE_WRITE, permissionCodes: ['order:list'] },
      ],
    })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY, ROLE_WRITE] })
    const res = await request(server())
      .get('/api/admin/goods/both')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('角色里的模块通配 goods:* 展开成注册表里的 goods 段全部权限点', async () => {
    h = await createHarness({ roles: [{ id: ROLE_WILDCARD, permissionCodes: ['goods:*'] }] })
    const token = await staffToken({ roleIds: [ROLE_WILDCARD] })
    await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
      .expect(201)
    const res = await request(server())
      .get('/api/admin/goods/both')
      .set('Authorization', `Bearer ${token}`)
    // goods:* 展不出 order:list，所以「与」表达式仍然不过。
    expect(res.body.code).toBe(1340300)
  })

  it('没有任何角色的员工，凡是带权限声明的路由一律拒', async () => {
    h = await createHarness()
    const token = await staffToken({ roleIds: [] })
    const res = await request(server())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1340300)
  })

  it('角色 id 在库里查不到（角色被删了）时按「没有权限」处理，而不是 500', async () => {
    h = await createHarness({ roles: [] })
    const token = await staffToken({ roleIds: ['ROLE0000000000000000GONE1'] })
    const res = await request(server())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1340300)
  })

  it('没有 @RequirePermission 的路由放行（默认拒绝由 GlobalAuthGuard 负责，不在这一环重复）', async () => {
    h = await createHarness()
    const token = await staffToken({ roleIds: [] })
    const res = await request(server())
      .get('/api/admin/goods/open')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('角色查询走 prisma.tenant：租户条件由扩展注入，守卫自己没写 tenantId', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list'] }] })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })
    await request(server()).get('/api/admin/goods').set('Authorization', `Bearer ${token}`)

    const calls = h.prisma.callsOf('Role', 'findMany')
    expect(calls).toHaveLength(1)
    // 租户扩展把租户条件 AND 进了 where——这条断言证明用的是 tenant 句柄而不是 raw。
    expect(JSON.stringify(calls[0]?.args)).toContain(TENANT)
  })
})

describe('用例②：isOwner 通过任何已注册权限点', () => {
  it('店主没有任何角色也能过 goods:write', async () => {
    h = await createHarness({ roles: [] })
    const token = await staffToken({ roleIds: [], isOwner: true })
    await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
      .expect(201)
  })

  it('店主过「与」表达式（等于拿到全部已注册权限点）', async () => {
    h = await createHarness({ roles: [] })
    const token = await staffToken({ roleIds: [], isOwner: true })
    const res = await request(server())
      .get('/api/admin/goods/both')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('店主不查 Role 表（ownerAll 直接展开注册表，省一次库）', async () => {
    h = await createHarness({ roles: [] })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY], isOwner: true })
    await request(server()).post('/api/admin/goods').set('Authorization', `Bearer ${token}`)
    expect(h.prisma.callsOf('Role', 'findMany')).toHaveLength(0)
  })

  it('店主也过不了未注册的权限点：全量 = 全部**已注册**，不是「无条件放行」', async () => {
    h = await createHarness({ roles: [] })
    const token = await staffToken({ roleIds: [], isOwner: true })
    const res = await request(server())
      .get('/api/admin/goods/ghost')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1340300)
  })
})

describe('用例③（运行时半边）：未注册的权限点', () => {
  it('永远拒绝，并打一条 error 日志指名道姓', async () => {
    h = await createHarness({ roles: [{ id: ROLE_WILDCARD, permissionCodes: ['*'] }] })
    const token = await staffToken({ roleIds: [ROLE_WILDCARD] })
    const res = await request(server())
      .get('/api/admin/goods/ghost')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1340300)
    expect(h.errors.some((e) => e.includes('ghost:code'))).toBe(true)
  })

  it('同一个未注册 code 的 error 只打一次，不刷屏', async () => {
    h = await createHarness({ roles: [{ id: ROLE_WILDCARD, permissionCodes: ['*'] }] })
    const token = await staffToken({ roleIds: [ROLE_WILDCARD] })
    await request(server()).get('/api/admin/goods/ghost').set('Authorization', `Bearer ${token}`)
    await request(server()).get('/api/admin/goods/ghost').set('Authorization', `Bearer ${token}`)
    await request(server()).get('/api/admin/goods/ghost').set('Authorization', `Bearer ${token}`)
    expect(h.errors.filter((e) => e.includes('ghost:code'))).toHaveLength(1)
  })
})

describe('用例④：platform 身份放行', () => {
  it('平台超管打商家侧权限点路由直接通过（TODO：平台侧细粒度）', async () => {
    h = await createHarness({ roles: [] })
    const { access } = await h.flow.login('platform', ADMIN)
    await request(server())
      .post('/api/platform/goods')
      .set('Authorization', `Bearer ${access}`)
      .expect(201)
  })

  it('platform 不查 Role 表', async () => {
    h = await createHarness({ roles: [] })
    const { access } = await h.flow.login('platform', ADMIN)
    await request(server()).post('/api/platform/goods').set('Authorization', `Bearer ${access}`)
    expect(h.prisma.callsOf('Role', 'findMany')).toHaveLength(0)
  })
})

describe('用例⑤：member 访问带 metadata 路由被拒', () => {
  it('member token 打带 @RequirePermission 的 admin 路由 → 1340300', async () => {
    h = await createHarness({ roles: [] })
    const { access } = await h.flow.login('member', MEMBER, TENANT)
    const res = await request(server())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${access}`)
    expect(res.body.code).toBe(1340300)
  })

  it('member 打没有权限声明的路由则不受本守卫影响', async () => {
    h = await createHarness({ roles: [] })
    const { access } = await h.flow.login('member', MEMBER, TENANT)
    const res = await request(server())
      .get('/api/admin/goods/open')
      .set('Authorization', `Bearer ${access}`)
    expect(res.body.code).toBe(0)
  })
})

describe('用例⑥：角色缓存 30 秒（假时钟）', () => {
  it('30 秒内改了库里的角色，旧权限仍然生效', async () => {
    const roles = [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list', 'goods:write'] }]
    h = await createHarness({ roles })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })

    await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
      .expect(201)

    // 库里把 goods:write 撤了，但时钟只走了 29 秒。
    roles[0]!.permissionCodes = ['goods:list']
    h.clock.advance(ROLE_CACHE_TTL_MS - 1000)

    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
    // 缓存命中：整个过程只查了一次库。
    expect(h.prisma.callsOf('Role', 'findMany')).toHaveLength(1)
  })

  it('超过 30 秒后自动失效，新权限生效', async () => {
    const roles = [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list', 'goods:write'] }]
    h = await createHarness({ roles })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })
    await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
      .expect(201)

    roles[0]!.permissionCodes = ['goods:list']
    h.clock.advance(ROLE_CACHE_TTL_MS + 1)

    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1340300)
    expect(h.prisma.callsOf('Role', 'findMany')).toHaveLength(2)
  })

  it('invalidateRoles(tenantId) 之后立即生效，一秒都不用等', async () => {
    const roles = [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list', 'goods:write'] }]
    h = await createHarness({ roles })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })
    await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
      .expect(201)

    roles[0]!.permissionCodes = ['goods:list']
    h.rolePermissions.invalidateRoles(TENANT)
    // 时钟一毫秒都没走。
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1340300)
  })

  it('invalidateRoles(别的租户) 不影响本租户的缓存', async () => {
    const roles = [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list', 'goods:write'] }]
    h = await createHarness({ roles })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })
    await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
      .expect(201)

    roles[0]!.permissionCodes = ['goods:list']
    h.rolePermissions.invalidateRoles('TENANT000000000000000000B')

    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('invalidateRoles() 不带参数时清空全部', async () => {
    const roles = [{ id: ROLE_LIST_ONLY, permissionCodes: ['goods:list', 'goods:write'] }]
    h = await createHarness({ roles })
    const token = await staffToken({ roleIds: [ROLE_LIST_ONLY] })
    await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
      .expect(201)
    expect(h.rolePermissions.cachedRoleCount).toBe(1)

    h.rolePermissions.invalidateRoles()
    expect(h.rolePermissions.cachedRoleCount).toBe(0)
  })

  it('查不到的角色也进缓存，避免每请求都打一次库', async () => {
    h = await createHarness({ roles: [] })
    const token = await staffToken({ roleIds: ['ROLE0000000000000000GONE1'] })
    await request(server()).get('/api/admin/goods').set('Authorization', `Bearer ${token}`)
    await request(server()).get('/api/admin/goods').set('Authorization', `Bearer ${token}`)
    expect(h.prisma.callsOf('Role', 'findMany')).toHaveLength(1)
  })
})
