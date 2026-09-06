import { describe, expect, it } from 'vitest'
import { assertMockNotInProd, MockSmsProvider } from './mock'

describe('MockSmsProvider', () => {
  it('只记录、总是成功，不做任何网络调用', async () => {
    const mock = new MockSmsProvider()
    const result = await mock.send({
      phone: '13800000000',
      templateKey: 'sms.login-code',
      params: { code: '1234' },
    })
    expect(result.ok).toBe(true)
    expect(mock.sent).toHaveLength(1)
    expect(mock.sent[0]!.req.phone).toBe('13800000000')
  })

  it('reset 清空记录', async () => {
    const mock = new MockSmsProvider()
    await mock.send({ phone: '13800000000', templateKey: 'k', params: {} })
    mock.reset()
    expect(mock.sent).toHaveLength(0)
  })
})

describe('assertMockNotInProd', () => {
  it('生产环境启用 mock 直接拒启', () => {
    expect(() => assertMockNotInProd({ NODE_ENV: 'production' }, ['mock', 'tencent-tc3'])).toThrow(
      '拒绝启动',
    )
  })

  it('生产环境未启用 mock 不抛', () => {
    expect(() =>
      assertMockNotInProd({ NODE_ENV: 'production' }, ['tencent-tc3', 'aliyun-rpc']),
    ).not.toThrow()
  })

  it('非生产环境启用 mock 不抛（本地/CI 的正常用法）', () => {
    expect(() => assertMockNotInProd({ NODE_ENV: 'test' }, ['mock'])).not.toThrow()
    expect(() => assertMockNotInProd({}, ['mock'])).not.toThrow()
  })
})
