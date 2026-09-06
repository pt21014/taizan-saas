import 'reflect-metadata'
import { runWithContext } from '@taizan/nest-core'
import type { RequestContext } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'
import { createFakePrisma, type FakePrismaControls } from '@taizan/nest-prisma/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditService } from './audit.service'

function baseCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ip: { client: '1.2.3.4', edge: '5.6.7.8' },
    startedAt: Date.now(),
    ...overrides,
  }
}

let controls: FakePrismaControls
let service: AuditService

beforeEach(() => {
  const fake = createFakePrisma()
  controls = fake.controls
  const prisma = new PrismaService(fake.client, {
    registered: new Set(['AuditLog']),
    softDeleteModels: new Set(),
    client: fake.client,
    connectOnInit: false,
  })
  service = new AuditService(prisma)
})

describe('AuditService.record（租户域 AuditLog）', () => {
  it('走 prisma.tenant，tenantId 由租户隔离扩展从上下文自动注入', async () => {
    await runWithContext(baseCtx({ tenantId: 't1' }), () =>
      service.record({
        action: 'goods.delete',
        actorType: 'STAFF',
        actorId: 's1',
        actorName: '张三',
      }),
    )

    const calls = controls.callsOf('AuditLog', 'create')
    expect(calls).toHaveLength(1)
    const data = calls[0]?.args as { data: Record<string, unknown> }
    expect(data.data.tenantId).toBe('t1')
    expect(data.data.action).toBe('goods.delete')
    expect(data.data.actorType).toBe('STAFF')
    expect(data.data.result).toBe('SUCCESS')
    expect(data.data.ip).toBe('1.2.3.4')
    expect(data.data.traceId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('无租户上下文时直接抛（不静默退化成查/写全表）', async () => {
    await expect(
      service.record({
        action: 'goods.delete',
        actorType: 'STAFF',
        actorId: 's1',
        actorName: '张三',
      }),
    ).rejects.toBeTruthy()
    expect(controls.callsOf('AuditLog', 'create')).toHaveLength(0)
  })

  // 用例⑨
  it('传 tx 时用 tx 写，不碰 prisma.tenant', async () => {
    const txCalls: unknown[] = []
    const tx = {
      auditLog: {
        create: async (args: unknown): Promise<null> => {
          txCalls.push(args)
          return null
        },
      },
    }

    await runWithContext(baseCtx({ tenantId: 't1' }), () =>
      service.record(
        { action: 'goods.delete', actorType: 'STAFF', actorId: 's1', actorName: '张三' },
        tx as unknown as Parameters<AuditService['record']>[1],
      ),
    )

    expect(txCalls).toHaveLength(1)
    expect(controls.callsOf('AuditLog', 'create')).toHaveLength(0)
    const data = (txCalls[0] as { data: Record<string, unknown> }).data
    expect(data.actorId).toBe('s1')
    // tx 客户端没有叠租户扩展，tenantId 不会被自动注入——调用方对 tx 的隔离行为负责。
    expect(data).not.toHaveProperty('tenantId')
  })
})

describe('AuditService.recordPlatform（平台域 PlatformAuditLog）', () => {
  it('走 prisma.raw，不注入 tenantId；actorType 缺省 PLATFORM_ADMIN', async () => {
    await runWithContext(baseCtx(), () =>
      service.recordPlatform({
        action: 'tenant.suspend',
        actorId: 'admin1',
        actorName: '平台超管',
        targetTenantId: 't1',
      }),
    )

    const calls = controls.callsOf('PlatformAuditLog', 'create')
    expect(calls).toHaveLength(1)
    const data = (calls[0]?.args as { data: Record<string, unknown> }).data
    expect(data).not.toHaveProperty('tenantId')
    expect(data.targetTenantId).toBe('t1')
    expect(data.actorType).toBe('PLATFORM_ADMIN')
    expect(data.action).toBe('tenant.suspend')
  })

  it('传 tx 时用 tx 写', async () => {
    const txCalls: unknown[] = []
    const tx = {
      platformAuditLog: {
        create: async (args: unknown): Promise<null> => {
          txCalls.push(args)
          return null
        },
      },
    }

    await service.recordPlatform(
      { action: 'tenant.suspend', actorId: 'admin1', actorName: '平台超管' },
      tx as unknown as Parameters<AuditService['recordPlatform']>[1],
    )

    expect(txCalls).toHaveLength(1)
    expect(controls.callsOf('PlatformAuditLog', 'create')).toHaveLength(0)
  })
})
