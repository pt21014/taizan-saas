import { describe, expect, it } from 'vitest'
import { SmsProviderRegistry } from './registry'
import type { SmsProvider, SmsResult, SmsSendRequest } from './provider'

function stubProvider(name: string, result: (req: SmsSendRequest) => SmsResult): SmsProvider {
  return {
    name,
    send: async (req) => result(req),
  }
}

describe('SmsProviderRegistry', () => {
  it('主厂商成功时只尝试一次', async () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubProvider('a', () => ({ ok: true, provider: 'a', vendorRef: 'x' })))
    registry.register(stubProvider('b', () => ({ ok: true, provider: 'b' })))

    const outcome = await registry.sendWithFallback(
      { phone: '13800000000', templateKey: 'k', params: {} },
      { a: {}, b: {} },
      { primary: 'a', fallbacks: ['b'] },
    )
    expect(outcome.result.provider).toBe('a')
    expect(outcome.attempts).toHaveLength(1)
  })

  it('主厂商失败自动切备用，两次尝试都落记录', async () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubProvider('a', () => ({ ok: false, provider: 'a', error: '余额不足' })))
    registry.register(stubProvider('b', () => ({ ok: true, provider: 'b', vendorRef: 'y' })))

    const outcome = await registry.sendWithFallback(
      { phone: '13800000000', templateKey: 'k', params: {} },
      { a: {}, b: {} },
      { primary: 'a', fallbacks: ['b'] },
    )
    expect(outcome.result.ok).toBe(true)
    expect(outcome.result.provider).toBe('b')
    expect(outcome.attempts).toHaveLength(2)
    expect(outcome.attempts[0]!.provider).toBe('a')
    expect(outcome.attempts[0]!.result.ok).toBe(false)
    expect(outcome.attempts[1]!.provider).toBe('b')
  })

  it('全部失败时返回最后一次结果，attempts 里每一次都能看到', async () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubProvider('a', () => ({ ok: false, provider: 'a', error: 'a 挂了' })))
    registry.register(stubProvider('b', () => ({ ok: false, provider: 'b', error: 'b 也挂了' })))

    const outcome = await registry.sendWithFallback(
      { phone: '13800000000', templateKey: 'k', params: {} },
      { a: {}, b: {} },
      { primary: 'a', fallbacks: ['b'] },
    )
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.provider).toBe('b')
    expect(outcome.attempts.map((a) => a.result.error)).toEqual(['a 挂了', 'b 也挂了'])
  })

  it('order 里出现未登记的 provider 名时抛错', async () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubProvider('a', () => ({ ok: true, provider: 'a' })))
    await expect(
      registry.sendWithFallback(
        { phone: '13800000000', templateKey: 'k', params: {} },
        { a: {} },
        { primary: 'not-registered' },
      ),
    ).rejects.toThrow('未登记的短信 provider')
  })

  it('provider 缺配置时抛错', async () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubProvider('a', () => ({ ok: true, provider: 'a' })))
    await expect(
      registry.sendWithFallback(
        { phone: '13800000000', templateKey: 'k', params: {} },
        {},
        { primary: 'a' },
      ),
    ).rejects.toThrow('缺少配置')
  })

  it('names() 列出已登记的 provider', () => {
    const registry = new SmsProviderRegistry()
    registry.register(stubProvider('a', () => ({ ok: true, provider: 'a' })))
    registry.register(stubProvider('b', () => ({ ok: true, provider: 'b' })))
    expect(registry.names().sort()).toEqual(['a', 'b'])
  })
})
