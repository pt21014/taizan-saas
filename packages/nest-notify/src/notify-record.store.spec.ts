import 'reflect-metadata'
import { runWithContext } from '@taizan/nest-core'
import type { RequestContext } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'
import { createFakePrisma, type FakePrismaControls } from '@taizan/nest-prisma/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { updateNotifyRecordStatus, writeNotifyRecord } from './notify-record.store'
import type { NotifyMessage, NotifyResult } from './types'

function baseCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ip: { client: '1.2.3.4', edge: '5.6.7.8' },
    startedAt: Date.now(),
    ...overrides,
  }
}

let controls: FakePrismaControls
let prisma: PrismaService

beforeEach(() => {
  const fake = createFakePrisma()
  controls = fake.controls
  prisma = new PrismaService(fake.client, {
    registered: new Set(['NotifyRecord']),
    softDeleteModels: new Set(),
    client: fake.client,
    connectOnInit: false,
  })
})

const message: NotifyMessage = {
  templateKey: 'sms.login-code',
  title: '登录验证码',
  content: '您的验证码是 1234',
  vars: { code: '1234' },
  to: { phone: '13800000000' },
}

describe('writeNotifyRecord', () => {
  it('有 tenantId 时走 tenant 句柄，写 NotifyRecord', async () => {
    await runWithContext(baseCtx({ tenantId: 't1' }), async () => {
      const result: NotifyResult = { ok: true, channel: 'SMS', vendorRef: 'abc' }
      await writeNotifyRecord(prisma, 'SMS', { ...message, tenantId: 't1' }, result, 'trace-1')
    })

    const calls = controls.callsOf('NotifyRecord', 'create')
    expect(calls).toHaveLength(1)
    const data = calls[0]?.args as { data: Record<string, unknown> }
    expect(data.data['tenantId']).toBe('t1')
    expect(data.data['status']).toBe('SENT')
    expect(data.data['to']).toBe('13800000000')
  })

  it('没有 tenantId 时走 raw 句柄，写 PlatformNotifyRecord', async () => {
    const result: NotifyResult = { ok: false, channel: 'SMS', error: '欠费' }
    await writeNotifyRecord(prisma, 'SMS', message, result, 'trace-2')

    expect(controls.callsOf('NotifyRecord', 'create')).toHaveLength(0)
    const calls = controls.callsOf('PlatformNotifyRecord', 'create')
    expect(calls).toHaveLength(1)
    const data = calls[0]?.args as { data: Record<string, unknown> }
    expect(data.data['targetTenantId']).toBeNull()
    expect(data.data['status']).toBe('FAILED')
    expect(data.data['error']).toBe('欠费')
  })

  it('result.attempts 有内容时按它展开成多条记录（主厂商失败切备用）', async () => {
    const result: NotifyResult = {
      ok: true,
      channel: 'SMS',
      vendorRef: 'y',
      attempts: [
        { ok: false, label: 'tencent-tc3', error: '余额不足' },
        { ok: true, label: 'aliyun-rpc', vendorRef: 'y' },
      ],
    }
    const lastId = await writeNotifyRecord(prisma, 'SMS', message, result, 'trace-3')

    const calls = controls.callsOf('PlatformNotifyRecord', 'create')
    expect(calls).toHaveLength(2)
    const first = (calls[0]?.args as { data: Record<string, unknown> }).data
    const second = (calls[1]?.args as { data: Record<string, unknown> }).data
    expect(first['status']).toBe('FAILED')
    expect(first['error']).toBe('余额不足')
    expect(second['status']).toBe('SENT')
    expect(second['id']).toBe(lastId)
  })

  it('没有 attempts 时只写一条，用 result 本身的状态', async () => {
    await writeNotifyRecord(prisma, 'SMS', message, { ok: true, channel: 'SMS' }, 'trace-4')
    expect(controls.callsOf('PlatformNotifyRecord', 'create')).toHaveLength(1)
  })

  // T1-5 真实 bug 的回归用例：channel 落库前必须转成 08-notify.prisma 的枚举字面量，
  // 否则 INBOX/MP_TEMPLATE 这两个 TS 字面量在 DB 枚举里根本不存在，真库上会被
  // Prisma 判为非法枚举值直接抛错——调用方外面常包着 try/catch，表现就是"一行都落不了库"。
  it('INBOX 落库时 channel 写的是 IN_APP，不是 INBOX', async () => {
    await runWithContext(baseCtx({ tenantId: 't1' }), async () => {
      const inboxMessage: NotifyMessage = { ...message, to: { userId: 'staff-1' }, tenantId: 't1' }
      const result: NotifyResult = { ok: true, channel: 'INBOX' }
      await writeNotifyRecord(prisma, 'INBOX', inboxMessage, result, 'trace-5')
    })

    const calls = controls.callsOf('NotifyRecord', 'create')
    expect(calls).toHaveLength(1)
    const data = (calls[0]?.args as { data: Record<string, unknown> }).data
    expect(data['channel']).toBe('IN_APP')
    expect(data['to']).toBe('staff-1')
  })

  it('MP_TEMPLATE 落库时 channel 写的是 WECHAT_MP，不是 MP_TEMPLATE', async () => {
    const mpMessage: NotifyMessage = { ...message, to: { openId: 'wx-openid-1' } }
    const result: NotifyResult = { ok: true, channel: 'MP_TEMPLATE' }
    await writeNotifyRecord(prisma, 'MP_TEMPLATE', mpMessage, result, 'trace-6')

    const calls = controls.callsOf('PlatformNotifyRecord', 'create')
    expect(calls).toHaveLength(1)
    const data = (calls[0]?.args as { data: Record<string, unknown> }).data
    expect(data['channel']).toBe('WECHAT_MP')
    expect(data['to']).toBe('wx-openid-1')
  })
})

describe('updateNotifyRecordStatus', () => {
  it('有 tenantId 时更新 NotifyRecord', async () => {
    await runWithContext(baseCtx({ tenantId: 't1' }), () =>
      updateNotifyRecordStatus(prisma, 'rec-1', 't1', { ok: true, channel: 'SMS', vendorRef: 'z' }),
    )
    const calls = controls.callsOf('NotifyRecord', 'update')
    expect(calls).toHaveLength(1)
    expect((calls[0]?.args as { where: { id: string } }).where.id).toBe('rec-1')
  })

  it('没有 tenantId 时更新 PlatformNotifyRecord', async () => {
    await updateNotifyRecordStatus(prisma, 'rec-2', undefined, {
      ok: false,
      channel: 'SMS',
      error: 'x',
    })
    const calls = controls.callsOf('PlatformNotifyRecord', 'update')
    expect(calls).toHaveLength(1)
    const data = (calls[0]?.args as { data: Record<string, unknown> }).data
    expect(data['status']).toBe('FAILED')
  })
})
