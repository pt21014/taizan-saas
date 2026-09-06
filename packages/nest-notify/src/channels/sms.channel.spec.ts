import { MockSmsProvider, SmsProviderRegistry, type SmsProvider, type SmsResult } from '@taizan/sms'
import { describe, expect, it } from 'vitest'
import { createSmsChannel } from './sms.channel'
import type { NotifyMessage } from '../types'

function stubProvider(name: string, result: SmsResult): SmsProvider {
  return { name, send: async () => result }
}

const message: NotifyMessage = {
  templateKey: 'sms.login-code',
  title: '登录验证码',
  content: '您的验证码是 1234',
  vars: { code: '1234' },
  to: { phone: '13800000000' },
}

describe('createSmsChannel', () => {
  it('主厂商成功时 attempts 只有一条', async () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubProvider('a', { ok: true, provider: 'a', vendorRef: 'x' }))
    const channel = createSmsChannel(
      { registry, cfgByProvider: { a: {} }, order: { primary: 'a' } },
      {},
    )
    const result = await channel.send(message)
    expect(result.ok).toBe(true)
    expect(result.attempts).toHaveLength(1)
  })

  it('主厂商失败自动切备用，attempts 里有两条记录', async () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubProvider('a', { ok: false, provider: 'a', error: '余额不足' }))
    registry.register(stubProvider('b', { ok: true, provider: 'b', vendorRef: 'y' }))
    const channel = createSmsChannel(
      { registry, cfgByProvider: { a: {}, b: {} }, order: { primary: 'a', fallbacks: ['b'] } },
      {},
    )
    const result = await channel.send(message)
    expect(result.ok).toBe(true)
    expect(result.vendorRef).toBe('y')
    expect(result.attempts).toHaveLength(2)
    expect(result.attempts?.[0]).toMatchObject({ ok: false, label: 'a', error: '余额不足' })
    expect(result.attempts?.[1]).toMatchObject({ ok: true, label: 'b', vendorRef: 'y' })
  })

  it('缺手机号时直接失败，不调用 registry', async () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubProvider('a', { ok: true, provider: 'a' }))
    const channel = createSmsChannel(
      { registry, cfgByProvider: { a: {} }, order: { primary: 'a' } },
      {},
    )
    const result = await channel.send({ ...message, to: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('缺少手机号')
  })

  it('生产环境启用 mock provider 直接拒启（assertMockNotInProd）', () => {
    const registry = new SmsProviderRegistry()
    registry.register(new MockSmsProvider())
    expect(() =>
      createSmsChannel(
        { registry, cfgByProvider: { mock: {} }, order: { primary: 'mock' } },
        { NODE_ENV: 'production' },
      ),
    ).toThrow('拒绝启动')
  })

  it('非生产环境启用 mock 不抛', () => {
    const registry = new SmsProviderRegistry()
    registry.register(new MockSmsProvider())
    expect(() =>
      createSmsChannel(
        { registry, cfgByProvider: { mock: {} }, order: { primary: 'mock' } },
        { NODE_ENV: 'test' },
      ),
    ).not.toThrow()
  })
})
