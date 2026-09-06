import { describe, expect, it } from 'vitest'
import { requireTemplate, resolveTemplateParams, type SmsTemplateRegistry } from './templates'

const registry: SmsTemplateRegistry = {
  'sms.login-code': { providerTemplateId: 'T1', paramOrder: ['code', 'ttl'] },
}

describe('resolveTemplateParams', () => {
  it('按 paramOrder 摊平成数组，不按对象键序', () => {
    expect(resolveTemplateParams(registry['sms.login-code']!, { ttl: '5', code: '9999' })).toEqual([
      '9999',
      '5',
    ])
  })

  it('缺变量时抛错，不把 undefined 拼进短信内容', () => {
    expect(() => resolveTemplateParams(registry['sms.login-code']!, { code: '9999' })).toThrow(
      '模板参数缺失',
    )
  })
})

describe('requireTemplate', () => {
  it('取到已登记的模板', () => {
    expect(requireTemplate(registry, 'sms.login-code').providerTemplateId).toBe('T1')
  })

  it('未登记的 key 抛错', () => {
    expect(() => requireTemplate(registry, 'sms.unknown')).toThrow('未登记的模板 key')
  })
})
