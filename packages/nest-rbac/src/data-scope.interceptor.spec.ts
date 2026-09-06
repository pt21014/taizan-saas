/**
 * T1-2 验收用例⑦：`@DataScope()` 与 `req.scopeWhere`。
 *
 * 断言的是「拦截器算出来的 where 片段」，而不是「查出来的数据对不对」——
 * 后者要连库，而且租户列刚好为空时也能过。翻译这件事本身发生了，才是这一层的命题。
 */

import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { activeMembership, createHarness, type Harness } from './__test__/harness'
import { mergeScopeWhere } from '@taizan/rbac-core'
import { FakeSubtreeResolver } from './testing/fixtures'

const ACCOUNT = 'ACCT0000000000000000000001'
const TENANT = 'TENANT000000000000000000A'
const STAFF = 'STAFF00000000000000000001'
const ROLE = 'ROLE00000000000000000LIST'

let h: Harness

afterEach(async () => {
  await h?.app.close()
})

function server(): Parameters<typeof request>[0] {
  return h.app.getHttpServer() as Parameters<typeof request>[0]
}

async function staffToken(
  membership: Partial<Parameters<typeof activeMembership>[0]> = {},
): Promise<string> {
  h.memberships.set(
    ACCOUNT,
    TENANT,
    activeMembership({ staffId: STAFF, roleIds: [ROLE], ...membership }),
  )
  const { access } = await h.flow.loginStaff(ACCOUNT, TENANT)
  return access
}

const ROLES = [{ id: ROLE, permissionCodes: ['goods:list'] }]

describe('用例⑦：@DataScope 的四档', () => {
  it('SELF → req.scopeWhere 是 { createdBy: staffId }', async () => {
    h = await createHarness({ roles: ROLES })
    const token = await staffToken({ dataScope: 'SELF' })
    const res = await request(server())
      .get('/api/admin/goods/scoped')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.scope).toEqual({ createdBy: STAFF })
  })

  it('ALL → null（不加任何条件；租户隔离另有其人）', async () => {
    h = await createHarness({ roles: ROLES })
    const token = await staffToken({ dataScope: 'ALL' })
    const res = await request(server())
      .get('/api/admin/goods/scoped')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.scope).toBeNull()
  })

  it('CUSTOM 且没有任何授权对象 → 永假条件 { createdBy: { in: [] } }，不是「查全部」', async () => {
    h = await createHarness({ roles: ROLES })
    const token = await staffToken({ dataScope: 'CUSTOM' })
    const res = await request(server())
      .get('/api/admin/goods/scoped')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.scope).toEqual({ createdBy: { in: [] } })
  })

  it('SUB_TREE → { deptId: { in: subtreeIds } }，subtreeIds 来自可注入的解析器', async () => {
    const subtree = new FakeSubtreeResolver(['DEPT1', 'DEPT2'])
    h = await createHarness({ roles: ROLES, subtreeResolver: subtree })
    const token = await staffToken({ dataScope: 'SUB_TREE' })
    const res = await request(server())
      .get('/api/admin/goods/scoped')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.scope).toEqual({ deptId: { in: ['DEPT1', 'DEPT2'] } })
    expect(subtree.calls).toBe(1)
  })

  it('SUB_TREE 解析出空列表 → 永假条件（一个都看不到，不是看全部）', async () => {
    h = await createHarness({ roles: ROLES, subtreeResolver: new FakeSubtreeResolver([]) })
    const token = await staffToken({ dataScope: 'SUB_TREE' })
    const res = await request(server())
      .get('/api/admin/goods/scoped')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.scope).toEqual({ deptId: { in: [] } })
  })

  it('默认 SubtreeResolver 把自己当一棵只有自己的树（退化成 SELF，方向是少给）', async () => {
    h = await createHarness({ roles: ROLES })
    const token = await staffToken({ dataScope: 'SUB_TREE' })
    const res = await request(server())
      .get('/api/admin/goods/scoped')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.scope).toEqual({ deptId: { in: [STAFF] } })
  })

  it('SUB_TREE 但 @DataScope 没给 groupField → 1340301，而不是退化成「不加条件」', async () => {
    h = await createHarness({ roles: ROLES })
    const token = await staffToken({ dataScope: 'SUB_TREE' })
    const res = await request(server())
      .get('/api/admin/goods/scoped-only')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1340301)
  })

  it('没标 @DataScope 的路由不写 req.scopeWhere，@ScopeWhere() 拿到 null', async () => {
    h = await createHarness({ roles: ROLES })
    const token = await staffToken({ dataScope: 'SELF' })
    const res = await request(server())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data).toEqual({ ok: true })
  })

  it('拦截器与守卫互不依赖：只标 @DataScope 不标权限也能拿到 scopeWhere', async () => {
    h = await createHarness({ roles: ROLES })
    const token = await staffToken({ dataScope: 'SELF' })
    const res = await request(server())
      .get('/api/admin/goods/scoped-only')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.scope).toEqual({ createdBy: STAFF })
  })

  it('数据范围与权限点正交：店主不自动升成 ALL（店主的 dataScope 本来就该在库里是 ALL）', async () => {
    h = await createHarness({ roles: [] })
    const token = await staffToken({ isOwner: true, dataScope: 'SELF' })
    const res = await request(server())
      .get('/api/admin/goods/scoped')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.data.scope).toEqual({ createdBy: STAFF })
  })
})

describe('@ScopeWhere() 与 mergeScopeWhere 的配合', () => {
  it('service 侧把业务 where 与 scope 用 AND 包起来，业务写同名字段也覆盖不掉', () => {
    const merged = mergeScopeWhere({ createdBy: '别人' }, { createdBy: STAFF })
    expect(merged).toEqual({ AND: [{ createdBy: '别人' }, { createdBy: STAFF }] })
  })

  it('scope 为 null 时原样返回业务 where', () => {
    expect(mergeScopeWhere({ status: 'PAID' }, null)).toEqual({ status: 'PAID' })
  })
})
