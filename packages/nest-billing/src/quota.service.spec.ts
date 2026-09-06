/**
 * `QuotaService` 与 `@ConsumeQuota()`：上下文取租户、先占后还。
 */

import { ErrorCode } from '@taizan/contracts'
import {
  BizException,
  MissingRequestContextError,
  runWithContext,
  TenantContextMissingError,
} from '@taizan/nest-core'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { QuotaService } from './quota.service'
import { FakePlatformGateway, tenantView } from './testing'
import { createHarness, fakePlan, type Harness } from './__test__/harness'

const TENANT = 'TENANT000000000000000000A'

function ctx<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      traceId: 'T1',
      tenantId: TENANT,
      ip: { client: '127.0.0.1', edge: '127.0.0.1' },
      startedAt: 0,
    },
    fn,
  )
}

function makeService(quotas: Record<string, number | null>): {
  service: QuotaService
  gateway: FakePlatformGateway
} {
  const gateway = new FakePlatformGateway()
  gateway.put(tenantView({ tenantId: TENANT, quotas }))
  return { service: new QuotaService(gateway), gateway }
}

describe('QuotaService 从上下文取租户', () => {
  it('压根没有请求上下文时抛错，而不是静默不限量', async () => {
    const { service } = makeService({ STAFF: 0 })
    // knowledge 的老实现在这里是 `if (!tenantId) return`——队列 job 里配额就此彻底失效。
    await expect(service.consume('STAFF')).rejects.toThrow(MissingRequestContextError)
  })

  it('有上下文但没有 tenantId（平台面请求）时也抛错', async () => {
    const { service } = makeService({ STAFF: 0 })
    const run = runWithContext(
      { traceId: 'T2', ip: { client: '127.0.0.1', edge: '127.0.0.1' }, startedAt: 0 },
      async () => service.consume('STAFF'),
    )
    await expect(run).rejects.toThrow(TenantContextMissingError)
  })

  it('limit=0 时 consume 抛 1540301（用例⑧的 service 侧）', async () => {
    const { service } = makeService({ STAFF: 0 })
    const err = await ctx(async () => service.consume('STAFF').catch((e: unknown) => e))
    expect((err as BizException).code).toBe(ErrorCode.QUOTA_EXCEEDED.code)
  })

  it('usage() 回三态快照，不写库', async () => {
    const { service, gateway } = makeService({ STAFF: 3 })
    gateway.setUsed(TENANT, 'STAFF', 2)
    const usage = await ctx(async () => service.usage('STAFF'))
    expect(usage).toEqual({ kind: 'STAFF', limit: 3, used: 2, remaining: 1 })
  })

  it('不限量维度的 usage：limit 与 remaining 都是 null', async () => {
    const { service } = makeService({})
    await expect(ctx(async () => service.usage('STAFF'))).resolves.toMatchObject({
      limit: null,
      remaining: null,
    })
  })

  it('consume 之后 check 会看到新的用量', async () => {
    const { service } = makeService({ STAFF: 2 })
    await ctx(async () => service.consume('STAFF'))
    const r = await ctx(async () => service.check('STAFF', 2))
    expect(r.ok).toBe(false)
    expect(r.remaining).toBe(1)
  })

  it('release 把占用还回去', async () => {
    const { service } = makeService({ STAFF: 1 })
    await ctx(async () => service.consume('STAFF'))
    await expect(ctx(async () => service.consume('STAFF'))).rejects.toThrow(BizException)
    await ctx(async () => service.release('STAFF'))
    await expect(ctx(async () => service.consume('STAFF'))).resolves.toMatchObject({ used: 1 })
  })
})

describe('@ConsumeQuota()：先占，业务失败再还（真 app）', () => {
  let h: Harness | undefined

  afterEach(async () => {
    await h?.app.close()
    h = undefined
  })

  function server(): Parameters<typeof request>[0] {
    return (h as Harness).app.getHttpServer() as Parameters<typeof request>[0]
  }

  it('额度够时放行，且计数 +1', async () => {
    h = await createHarness({ plans: [fakePlan({ quotas: { STAFF: 3 } })] })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
    expect(h.counters.get(`${TENANT}:STAFF`)?.used).toBe(1)
  })

  it('limit=0 时业务代码根本不跑，直接 1540301', async () => {
    h = await createHarness({ plans: [fakePlan({ quotas: { STAFF: 0 } })] })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(ErrorCode.QUOTA_EXCEEDED.code)
    expect(h.counters.get(`${TENANT}:STAFF`)).toBeUndefined()
  })

  it('业务抛错时把刚占的还回去，计数不虚高', async () => {
    h = await createHarness({ plans: [fakePlan({ quotas: { STAFF: 3 } })] })
    const token = await h.staffToken()
    await request(server()).post('/api/admin/staff/boom').set('Authorization', `Bearer ${token}`)
    // 归还是异步的（catchError 里 void 掉了），等一个宏任务。
    await new Promise((r) => setTimeout(r, 10))
    expect(h.counters.get(`${TENANT}:STAFF`)?.used).toBe(0)
  })

  it('没打装饰器的路由不受影响（拦截器对它是零开销）', async () => {
    h = await createHarness({ plans: [fakePlan({ quotas: { STAFF: 0 } })] })
    const token = await h.staffToken()
    const res = await request(server())
      .post('/api/admin/goods')
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.code).toBe(0)
  })
})
