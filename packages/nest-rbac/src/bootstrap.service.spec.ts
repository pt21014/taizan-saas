/**
 * T1-2 验收用例⑧：`buildBootstrap` 的菜单裁剪。
 */

import type { BootstrapIdentity, BootstrapTenant, MenuNode } from '@taizan/contracts'
import type { AuthPrincipal } from '@taizan/nest-auth'
import { runWithContext, type RequestContext } from '@taizan/nest-core'
import { afterEach, describe, expect, it } from 'vitest'
import { activeMembership, createHarness, type Harness } from './__test__/harness'

const ACCOUNT = 'ACCT0000000000000000000001'
const TENANT = 'TENANT000000000000000000A'
const STAFF = 'STAFF00000000000000000001'
const ROLE_LIST = 'ROLE00000000000000000LIST'

let h: Harness

afterEach(async () => {
  await h?.app.close()
})

const IDENTITY: BootstrapIdentity = {
  staffId: STAFF,
  accountId: ACCOUNT,
  name: '张三',
  isOwner: false,
}

const TENANT_SNAPSHOT: BootstrapTenant = {
  id: TENANT,
  slug: 'shop-a',
  name: 'A 店',
  status: 'ACTIVE',
  planExpireAt: null,
  readonly: false,
  features: null,
}

function principal(overrides: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return {
    kind: 'staff',
    id: STAFF,
    jti: 'JTI0000000000000000000001',
    tenantId: TENANT,
    accountId: ACCOUNT,
    roleIds: [ROLE_LIST],
    dataScope: 'ALL',
    isOwner: false,
    ...overrides,
  }
}

/**
 * 真实请求里这个上下文由 `ContextMiddleware` + `GlobalAuthGuard` 建好；直接调 service
 * 时必须自己套一层，否则 `prisma.tenant` 的租户扩展会（正确地）抛 `TenantScopeError`。
 * 这条本身就是隔离层在起作用的证据，所以不绕过它，而是照真实形状补上。
 */
const CONTEXT: RequestContext = {
  traceId: 'TRACE0000000000000000001',
  tenantId: TENANT,
  ip: { client: '127.0.0.1', edge: '127.0.0.1' },
  startedAt: 0,
}

/** 在租户上下文里调 `buildBootstrap`。 */
function build(
  principal: AuthPrincipal,
  opts: Parameters<Harness['bootstrap']['buildBootstrap']>[1],
): ReturnType<Harness['bootstrap']['buildBootstrap']> {
  return runWithContext(CONTEXT, () => h.bootstrap.buildBootstrap(principal, opts))
}

/** 把菜单树摊平成 key 列表，断言起来一眼能看懂。 */
function keys(nodes: readonly MenuNode[]): string[] {
  const out: string[] = []
  const walk = (list: readonly MenuNode[]): void => {
    for (const node of list) {
      out.push(node.key)
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

describe('用例⑧：buildBootstrap 的菜单裁剪', () => {
  it('没权限的菜单项不出现在结果里', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['goods:list'] }] })
    h.memberships.set(ACCOUNT, TENANT, activeMembership())

    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
    })
    // goods.create（goods:write）、goods.export（goods:export）、order.*、coupon 全被裁掉；
    // goods 目录因为还剩 goods.list 所以留着。
    expect(keys(res.menus)).toEqual(['goods', 'goods.list'])
  })

  it('DIR 的子节点被裁光时它自己也消失（不留一个点进去空空如也的目录）', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['order:list'] }] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
    })
    expect(keys(res.menus)).toEqual(['order', 'order.list'])
  })

  it('features = null（全部可用）时带 featureKey 的菜单全保留', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['*'] }] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
    })
    expect(keys(res.menus)).toEqual([
      'goods',
      'goods.list',
      'goods.create',
      'goods.export',
      'order',
      'order.list',
      'coupon',
    ])
  })

  it('features = []（一个都不给）时带 featureKey 的菜单全消失', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['*'] }] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: [],
    })
    // order.list 与 coupon 都带 featureKey；order 目录因此连锁消失。
    expect(keys(res.menus)).toEqual(['goods', 'goods.list', 'goods.create', 'goods.export'])
  })

  it('features = ["order"] 时只保留 order，营销消失（三态里的第三态）', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['*'] }] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: ['order'],
    })
    expect(keys(res.menus)).toContain('order.list')
    expect(keys(res.menus)).not.toContain('coupon')
  })

  it('disabledMenuKeys 命中的整棵子树移除', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['*'] }] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
      disabledMenuKeys: ['goods'],
    })
    expect(keys(res.menus)).toEqual(['order', 'order.list', 'coupon'])
  })

  it('只下发本侧菜单：ADMIN 里看不到 PLATFORM 的入口', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['*'] }] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
    })
    expect(keys(res.menus)).not.toContain('platform.tenant')
  })

  it('side: PLATFORM 时下发平台侧', async () => {
    h = await createHarness({ roles: [] })
    const res = await build(principal({ kind: 'platform', isOwner: false }), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
      side: 'PLATFORM',
    })
    expect(keys(res.menus)).toEqual(['platform.tenant'])
  })

  it('下发的节点不含 featureKey / side（前端拿不到裁剪依据，无法造出第二份真源）', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['*'] }] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
    })
    const serialized = JSON.stringify(res.menus)
    expect(serialized).not.toContain('featureKey')
    expect(serialized).not.toContain('"side"')
    // permission 反而保留：前端按钮级 usePerm(code) 要用，且能出现在结果里的本来就已经有权限。
    expect(serialized).toContain('goods:list')
  })

  it('permissions 是展开后的码，且排序稳定（同一份输入永远给出同一份 JSON）', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['goods:*'] }] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
    })
    expect(res.permissions).toEqual(['goods:export', 'goods:list', 'goods:write'])
  })

  it('店主拿到全部已注册权限点与全部菜单', async () => {
    h = await createHarness({ roles: [] })
    const res = await build(principal({ isOwner: true, roleIds: [] }), {
      identity: { ...IDENTITY, isOwner: true },
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
    })
    expect(res.permissions).toHaveLength(6)
    expect(keys(res.menus)).toContain('coupon')
  })

  it('identity / tenant / shops / quotas 原样透传（本包不发明这几段数据）', async () => {
    h = await createHarness({ roles: [] })
    const shops = [{ tenantId: TENANT, name: 'A 店', slug: 'shop-a' }]
    const quotas = { staff: { used: 3, limit: 10 } }
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops,
      features: null,
      quotas,
    })
    expect(res.identity).toBe(IDENTITY)
    expect(res.tenant).toBe(TENANT_SNAPSHOT)
    expect(res.shops).toBe(shops)
    expect(res.quotas).toBe(quotas)
  })

  it('不传 quotas 时是空对象（不是 undefined，前端可以直接 for-in）', async () => {
    h = await createHarness({ roles: [] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
    })
    expect(res.quotas).toEqual({})
  })

  it('bootstrap 与守卫用的是同一份 granted（菜单里看得到 = 接口调得通）', async () => {
    h = await createHarness({ roles: [{ id: ROLE_LIST, permissionCodes: ['goods:list'] }] })
    const res = await build(principal(), {
      identity: IDENTITY,
      tenant: TENANT_SNAPSHOT,
      shops: [],
      features: null,
    })
    const granted = await runWithContext(CONTEXT, () => h.rolePermissions.grantedFor(principal()))
    expect(res.permissions).toEqual([...granted].sort())
  })
})
