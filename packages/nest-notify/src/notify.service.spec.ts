import 'reflect-metadata'
import { runWithContext } from '@taizan/nest-core'
import type { RequestContext } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'
import { createFakePrisma, type FakePrismaControls } from '@taizan/nest-prisma/testing'
import type { QueueService } from '@taizan/nest-infra'
import { MockSmsProvider, SmsProviderRegistry, type SmsProvider, type SmsResult } from '@taizan/sms'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createInboxChannel } from './channels/inbox.channel'
import { createSmsChannel } from './channels/sms.channel'
import { InMemoryTemplateSource, type NotifyTemplateDef } from './template-source'
import { NotifyService } from './notify.service'
import type { NotifyChannelDriver } from './types'

function baseCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    traceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ip: { client: '1.2.3.4', edge: '5.6.7.8' },
    startedAt: Date.now(),
    ...overrides,
  }
}

function stubSmsProvider(name: string, result: SmsResult): SmsProvider {
  return { name, send: async () => result }
}

let controls: FakePrismaControls
let prisma: PrismaService
let queueAdd: ReturnType<typeof vi.fn>
let queue: QueueService

const templates: Record<string, NotifyTemplateDef> = {
  'sms.login-code': {
    title: '登录验证码',
    content: '您的验证码是 {{code}}，{{ttl}} 分钟内有效',
    channel: 'SMS',
    enabled: true,
  },
  'tenant.plan.expiring': {
    title: '套餐到期提醒',
    content: '您的套餐将于 {{date}} 到期',
    channel: 'INBOX',
    enabled: true,
  },
  'tenant.disabled': {
    title: '已停用模板',
    content: 'x',
    channel: 'SMS',
    enabled: false,
  },
}

beforeEach(() => {
  const fake = createFakePrisma()
  controls = fake.controls
  prisma = new PrismaService(fake.client, {
    registered: new Set(['NotifyRecord']),
    softDeleteModels: new Set(),
    client: fake.client,
    connectOnInit: false,
  })
  queueAdd = vi.fn(async () => 'job-1')
  queue = { add: queueAdd } as unknown as QueueService
})

function buildService(channels: NotifyChannelDriver[]): NotifyService {
  return new NotifyService(prisma, queue, channels, new InMemoryTemplateSource(templates))
}

describe('NotifyService.send：主厂商失败自动切备用', () => {
  it('SMS 主厂商失败切备用后整体成功，落 NotifyRecord，不进重试队列', async () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubSmsProvider('a', { ok: false, provider: 'a', error: '余额不足' }))
    registry.register(stubSmsProvider('b', { ok: true, provider: 'b', vendorRef: 'y' }))
    const smsChannel = createSmsChannel(
      { registry, cfgByProvider: { a: {}, b: {} }, order: { primary: 'a', fallbacks: ['b'] } },
      {},
    )

    const service = buildService([smsChannel])
    const results = await service.send({
      templateKey: 'sms.login-code',
      to: { phone: '13800000000' },
      vars: { code: '1234', ttl: '5' },
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.ok).toBe(true)
    expect(queueAdd).not.toHaveBeenCalled()

    // 平台域（没传 tenantId）：走 raw，两次尝试都要落一条记录
    const calls = controls.callsOf('PlatformNotifyRecord', 'create')
    expect(calls).toHaveLength(2)
    expect((calls[0]?.args as { data: { status: string } }).data.status).toBe('FAILED')
    expect((calls[1]?.args as { data: { status: string } }).data.status).toBe('SENT')
  })
})

describe('NotifyService.send：INBOX 有 tenantId 走 tenant 句柄', () => {
  it('写进 NotifyRecord（tenant 句柄），不是 PlatformNotifyRecord', async () => {
    const service = buildService([createInboxChannel()])
    await runWithContext(baseCtx({ tenantId: 't1' }), () =>
      service.send({
        tenantId: 't1',
        templateKey: 'tenant.plan.expiring',
        to: { userId: 'staff-1' },
        vars: { date: '2026-10-01' },
      }),
    )

    expect(controls.callsOf('NotifyRecord', 'create')).toHaveLength(1)
    expect(controls.callsOf('PlatformNotifyRecord', 'create')).toHaveLength(0)
    const data = controls.callsOf('NotifyRecord', 'create')[0]?.args as {
      data: Record<string, unknown>
    }
    expect(data.data['tenantId']).toBe('t1')
    // 落库的是 DB 枚举字面量 IN_APP，不是本包的 INBOX——两套命名的转换见
    // `channel-map.ts`（T1-5 那条「INBOX 一行都落不了库」的 bug 就出在这一列）。
    expect(data.data['channel']).toBe('IN_APP')
  })
})

describe('NotifyService.send：模板参数缺失抛错', () => {
  it('渲染前缺变量直接抛，不产生任何 NotifyRecord', async () => {
    const service = buildService([createInboxChannel()])
    await expect(
      service.send({
        templateKey: 'sms.login-code',
        to: { phone: '13800000000' },
        vars: { code: '1234' }, // 缺 ttl
      }),
    ).rejects.toThrow('模板参数缺失')
    expect(controls.calls).toHaveLength(0)
  })

  it('未登记的模板 key 抛错', async () => {
    const service = buildService([createInboxChannel()])
    await expect(service.send({ templateKey: 'unknown', to: {}, vars: {} })).rejects.toThrow(
      '未登记的模板 key',
    )
  })

  it('已停用的模板抛错', async () => {
    const service = buildService([createInboxChannel()])
    await expect(
      service.send({ templateKey: 'tenant.disabled', to: {}, vars: {} }),
    ).rejects.toThrow('已停用')
  })
})

describe('NotifyService.send：fallback 按 channels 顺序降级', () => {
  it('第一个通道失败、第二个成功：只落两条记录，不进重试队列', async () => {
    const failingSms = createSmsChannel(
      {
        registry: (() => {
          const r = new SmsProviderRegistry()
          r.register(stubSmsProvider('a', { ok: false, provider: 'a', error: '挂了' }))
          return r
        })(),
        cfgByProvider: { a: {} },
        order: { primary: 'a' },
      },
      {},
    )
    const inbox = createInboxChannel()

    const service = buildService([failingSms, inbox])
    const results = await service.send({
      templateKey: 'sms.login-code',
      to: { phone: '13800000000', userId: 'staff-1' },
      vars: { code: '1234', ttl: '5' },
      channels: ['SMS', 'INBOX'],
      fallback: true,
    })

    expect(results.map((r) => r.channel)).toEqual(['SMS', 'INBOX'])
    expect(results[0]?.ok).toBe(false)
    expect(results[1]?.ok).toBe(true)
    expect(queueAdd).not.toHaveBeenCalled()
  })

  it('整条降级链都失败：只对最后一次尝试的通道入队重试', async () => {
    const failA = createSmsChannel(
      {
        registry: (() => {
          const r = new SmsProviderRegistry()
          r.register(stubSmsProvider('a', { ok: false, provider: 'a', error: 'a 挂了' }))
          return r
        })(),
        cfgByProvider: { a: {} },
        order: { primary: 'a' },
      },
      {},
    )
    const failInbox: NotifyChannelDriver = {
      kind: 'INBOX',
      send: async () => ({ ok: false, channel: 'INBOX', error: 'inbox 也挂了' }),
    }

    const service = buildService([failA, failInbox])
    const results = await service.send({
      templateKey: 'sms.login-code',
      to: { phone: '13800000000', userId: 'staff-1' },
      vars: { code: '1234', ttl: '5' },
      channels: ['SMS', 'INBOX'],
      fallback: true,
    })

    expect(results.every((r) => !r.ok)).toBe(true)
    expect(queueAdd).toHaveBeenCalledTimes(1)
    const payload = queueAdd.mock.calls[0]?.[1] as { channel: string }
    expect(payload.channel).toBe('INBOX')
  })
})

describe('NotifyService.send：广播模式下每个失败通道各自入队重试', () => {
  it('两个通道都失败：各自落记录、各自入队', async () => {
    const failA = createSmsChannel(
      {
        registry: (() => {
          const r = new SmsProviderRegistry()
          r.register(stubSmsProvider('a', { ok: false, provider: 'a', error: 'a 挂了' }))
          return r
        })(),
        cfgByProvider: { a: {} },
        order: { primary: 'a' },
      },
      {},
    )
    const failInbox: NotifyChannelDriver = {
      kind: 'INBOX',
      send: async () => ({ ok: false, channel: 'INBOX', error: 'inbox 也挂了' }),
    }

    const service = buildService([failA, failInbox])
    const results = await service.send({
      templateKey: 'sms.login-code',
      to: { phone: '13800000000', userId: 'staff-1' },
      vars: { code: '1234', ttl: '5' },
      channels: ['SMS', 'INBOX'],
      // fallback 不传：广播语义
    })

    expect(results).toHaveLength(2)
    expect(queueAdd).toHaveBeenCalledTimes(2)
  })
})

describe('生产环境启用 mock provider', () => {
  it('装配 SMS 通道时直接拒启', () => {
    const registry = new SmsProviderRegistry()
    registry.register(new MockSmsProvider())
    expect(() =>
      createSmsChannel(
        { registry, cfgByProvider: { mock: {} }, order: { primary: 'mock' } },
        { NODE_ENV: 'production' },
      ),
    ).toThrow('拒绝启动')
  })
})
