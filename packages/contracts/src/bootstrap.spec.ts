import { describe, expect, it } from 'vitest'

import type { BootstrapResponse } from './bootstrap'

describe('BootstrapResponse', () => {
  it('蓝图 §4.4 给出的形状可以被正常构造、JSON 序列化往返', () => {
    const sample: BootstrapResponse = {
      identity: {
        staffId: 'staff_01',
        accountId: 'account_01',
        name: '张三',
        avatar: null,
        isOwner: true,
      },
      tenant: {
        id: 'tenant_01',
        slug: 'demo-shop',
        name: '示例店铺',
        status: 'ACTIVE',
        planExpireAt: '2026-12-31T15:59:59.000Z',
        readonly: false,
        closedReason: null,
        features: null,
      },
      shops: [{ tenantId: 'tenant_01', name: '示例店铺', slug: 'demo-shop' }],
      permissions: ['goods:list', 'goods:write'],
      menus: [
        {
          key: 'goods',
          title: '商品',
          type: 'DIR',
          sort: 10,
          children: [
            {
              key: 'goods.list',
              title: '商品列表',
              path: '/goods',
              componentKey: 'GoodsList',
              type: 'MENU',
              sort: 10,
            },
          ],
        },
      ],
      quotas: { staff: { used: 2, limit: 10 }, storage: { used: 100, limit: null } },
    }

    const roundTrip = JSON.parse(JSON.stringify(sample)) as BootstrapResponse
    expect(roundTrip).toEqual(sample)
    expect(roundTrip.quotas['storage']?.limit).toBeNull()
    expect(roundTrip.tenant.features).toBeNull()
  })
})
