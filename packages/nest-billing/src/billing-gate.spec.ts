/**
 * T1-4 的验收用例 ①–⑦、⑪（后台闸门 + 功能开关 + C 端打烊）。
 *
 * 每个 `it` 的开头标了它对应任务分解里的哪一条，改这个文件之前先确认对应关系还在。
 */

import type { FeatureDef } from '@taizan/billing-rules'
import { ErrorCode } from '@taizan/contracts'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { BillingModule } from './billing.module'
import { createHarness, fakePlan, fakeTenant, TENANT, type Harness } from './__test__/harness'

let h: Harness | undefined

afterEach(async () => {
  await h?.app.close()
  h = undefined
})

function server(): Parameters<typeof request>[0] {
  return (h as Harness).app.getHttpServer() as Parameters<typeof request>[0]
}

/** 相对「现在」（harness 的假时钟停在 2026-06-15）偏移若干天。 */
function daysFromNow(days: number): Date {
  return new Date(Date.UTC(2026, 5, 15, 4, 0, 0) + days * 86_400_000)
}

const MARKETING: FeatureDef = {
  key: 'marketing',
  name: '营销中心',
  writeOnly: true,
  pathPrefixes: ['/api/admin/marketing'],
}

describe('用例①：planExpireAt 是昨天 + enforce', () => {
  it('POST /api/admin/goods 被拦，返回 1440301', async () => {
    h = await createHarness({ tenants: [fakeTenant({ planExpireAt: daysFromNow(-1) })] })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(ErrorCode.PLAN_READONLY.code)
    expect(res.body.code).toBe(1440301)
    // 前端要据此把「去续费」指到白名单里的页面，指错了就又是那个死循环。
    expect(res.body.data.renewalPath).toBe('/api/admin/billing')
  })

  it('GET 仍然通——到期是「只读」不是「关门」，商家得能看到自己欠了多少', async () => {
    h = await createHarness({ tenants: [fakeTenant({ planExpireAt: daysFromNow(-1) })] })
    const token = await h.staffToken()
    const res = await request(server())
      .get('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('DELETE 也拦——写方法是四个，不是只有 POST', async () => {
    h = await createHarness({ tenants: [fakeTenant({ planExpireAt: daysFromNow(-1) })] })
    const token = await h.staffToken()
    const res = await request(server())
      .delete('/api/admin/goods/x')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1440301)
  })

  it('POST /api/admin/billing/order 放行——续费白名单永远可写', async () => {
    h = await createHarness({ tenants: [fakeTenant({ planExpireAt: daysFromNow(-1) })] })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/billing/order')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })
})

describe('用例②：宽限期', () => {
  it('到期 2 天 + graceDays=7，后台仍可写', async () => {
    h = await createHarness({
      tenants: [fakeTenant({ planExpireAt: daysFromNow(-2), graceDays: 7 })],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('过了宽限期就拦（到期 9 天 + graceDays=7）', async () => {
    h = await createHarness({
      tenants: [fakeTenant({ planExpireAt: daysFromNow(-9), graceDays: 7 })],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1440301)
  })
})

describe('用例③：TRIAL 用 trialEndAt 而不是 planExpireAt', () => {
  it('试用未到期（planExpireAt 为空）照样可写', async () => {
    h = await createHarness({
      tenants: [
        fakeTenant({
          status: 'TRIAL',
          planExpireAt: null,
          trialEndAt: daysFromNow(3),
          planId: null,
        }),
      ],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('试用已过期就拦', async () => {
    h = await createHarness({
      tenants: [
        fakeTenant({
          status: 'TRIAL',
          planExpireAt: null,
          trialEndAt: daysFromNow(-1),
          planId: null,
        }),
      ],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1440301)
  })
})

describe('用例④：SUSPENDED 与开关无关', () => {
  it('enforce=false 也拦——平台逐个按下去的，开关掀不动', async () => {
    h = await createHarness({
      enforce: false,
      tenants: [fakeTenant({ status: 'SUSPENDED' })],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1440301)
    expect(res.body.message).toContain('冻结')
  })

  it('DEREGISTERED 同理', async () => {
    h = await createHarness({
      enforce: false,
      tenants: [fakeTenant({ status: 'DEREGISTERED' })],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1440301)
  })
})

describe('用例⑤：enforce=false 时到期租户放行且打 warn', () => {
  it('放行 + logger.warn 被调，文案带 BILLING_ENFORCE=false 便于 grep', async () => {
    h = await createHarness({
      enforce: false,
      tenants: [fakeTenant({ planExpireAt: daysFromNow(-30) })],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)

    const warn = h.warnings.find((w) => w.includes('BILLING_ENFORCE=false'))
    expect(warn).toBeDefined()
    expect(warn).toContain(TENANT)
    expect(warn).toContain('POST /api/admin/goods')
    expect(warn).toContain('EXPIRED')
  })

  it('没到期的租户不打 warn——不然日志里全是噪音，真出事时看不见', async () => {
    h = await createHarness({ enforce: false, tenants: [fakeTenant()] })
    const token = await h.staffToken()
    await request(server()).post('/api/admin/goods').set('Authorization', `Bearer ${token}`)
    expect(h.warnings.some((w) => w.includes('BILLING_ENFORCE=false'))).toBe(false)
  })
})

describe('用例⑥：功能开关三态', () => {
  it('features=[] 时，命中 pathPrefixes 的写请求 1540302', async () => {
    h = await createHarness({
      features: [MARKETING],
      plans: [fakePlan({ features: [] })],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/marketing/coupons')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(ErrorCode.FEATURE_NOT_INCLUDED.code)
    expect(res.body.code).toBe(1540302)
    expect(res.body.data.feature).toBe('marketing')
  })

  it('features=[] 时读请求仍然通（MARKETING 是 writeOnly）', async () => {
    h = await createHarness({ features: [MARKETING], plans: [fakePlan({ features: [] })] })
    const token = await h.staffToken()
    const res = await request(server())
      .get('/api/admin/marketing/coupons')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('features=null（套餐没配）时全通——null 是「全部可用」，不是「一个都没有」', async () => {
    h = await createHarness({ features: [MARKETING], plans: [fakePlan({ features: null })] })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/marketing/coupons')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('features 里包含这一项时放行', async () => {
    h = await createHarness({
      features: [MARKETING],
      plans: [fakePlan({ features: ['marketing'] })],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/marketing/coupons')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })

  it('没有套餐（planId 为 null）时 features 视为 null，不误伤', async () => {
    h = await createHarness({
      features: [MARKETING],
      tenants: [fakeTenant({ planId: null, planExpireAt: daysFromNow(30) })],
    })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/marketing/coupons')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })
})

describe('用例⑦：功能开关遮蔽续费白名单，启动就炸', () => {
  it('前缀盖住 /api/admin/billing 时 forRoot 抛错', () => {
    expect(() =>
      BillingModule.forRoot({
        features: [
          { key: 'admin-all', name: '整个后台', writeOnly: true, pathPrefixes: ['/api/admin'] },
        ],
      }),
    ).toThrow(/遮蔽了续费白名单/)
  })

  it('前缀钻进 /api/admin/billing 里面也算（NESTED）', () => {
    expect(() =>
      BillingModule.forRoot({
        features: [
          {
            key: 'invoice',
            name: '发票',
            writeOnly: true,
            pathPrefixes: ['/api/admin/billing/invoice'],
          },
        ],
      }),
    ).toThrow(/遮蔽了续费白名单/)
  })

  it('正常的前缀不炸', () => {
    expect(() => BillingModule.forRoot({ features: [MARKETING] })).not.toThrow()
  })
})

describe('非 staff 身份与非写方法不进闸门', () => {
  it('平台超管不受商家闸门管——平台自己要能给到期商家操作', async () => {
    h = await createHarness({ tenants: [fakeTenant({ planExpireAt: daysFromNow(-1) })] })
    const { access } = await h.flow.login('platform', 'ADMIN00000000000000000001')
    // 控制器本身没声明 @Auth('staff')，所以平台 token 能进；闸门放它过。
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${access}`)
    expect(res.body.code).toBe(0)
  })
})

describe('用例⑪：C 端闸门中间件', () => {
  it('到期 → 1440302 打烊，且读请求也拦（顾客不需要只读）', async () => {
    h = await createHarness({ tenants: [fakeTenant({ planExpireAt: daysFromNow(-1) })] })
    const res = await request(server()).get('/api/client/goods')
    expect(res.body.code).toBe(ErrorCode.SHOP_CLOSED.code)
    expect(res.body.code).toBe(1440302)
  })

  it('SUSPENDED → 1440302，且与开关无关', async () => {
    h = await createHarness({ enforce: false, tenants: [fakeTenant({ status: 'SUSPENDED' })] })
    const res = await request(server()).get('/api/client/goods')
    expect(res.body.code).toBe(1440302)
    expect(res.body.message).toBe('店铺已停止营业')
  })

  it('enforce=false 的到期租户放行并打 warn', async () => {
    h = await createHarness({
      enforce: false,
      tenants: [fakeTenant({ planExpireAt: daysFromNow(-1) })],
    })
    const res = await request(server()).get('/api/client/goods')
    expect(res.body.code).toBe(0)
    expect(h.warnings.some((w) => w.includes('BILLING_ENFORCE=false'))).toBe(true)
  })

  it('正常租户放行，且上下文里的 tenantId 还在（中间件没吃掉它）', async () => {
    h = await createHarness()
    const res = await request(server()).get('/api/client/goods')
    expect(res.body.code).toBe(0)
    expect(res.body.data.tenantId).toBe(TENANT)
  })

  it('租户还没解析出来时放行——那是 TenantMiddleware 该报 1240400 的事', async () => {
    h = await createHarness({
      clientTenantId: null,
      tenants: [fakeTenant({ status: 'SUSPENDED' })],
    })
    const res = await request(server()).get('/api/client/goods')
    expect(res.body.code).toBe(0)
  })

  it('不在 /api/client 前缀下的请求不进这道闸门（后台归后台）', async () => {
    h = await createHarness({ tenants: [fakeTenant({ planExpireAt: daysFromNow(-1) })] })
    const token = await h.staffToken()
    // 打烊中间件若误伤 /api/admin，这里会变成 1440302 而不是 1440301。
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(1440301)
  })
})
