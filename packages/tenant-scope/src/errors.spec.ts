import { describe, expect, it } from 'vitest'

import { TenantScopeError, isTenantScopeError } from './errors'

describe('TenantScopeError', () => {
  it('带上 reason 与定位信息', () => {
    const error = new TenantScopeError('NO_CONTEXT', '缺上下文', {
      model: 'Scoped',
      operation: 'findMany',
      tenantId: 't1',
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TenantScopeError')
    expect(error.reason).toBe('NO_CONTEXT')
    expect(error.model).toBe('Scoped')
    expect(error.operation).toBe('findMany')
    expect(error.tenantId).toBe('t1')
    expect(error.message).toBe('缺上下文')
  })

  it('不给 context 时三个定位字段都是 undefined', () => {
    const error = new TenantScopeError('UNKNOWN_OPERATION', '不认识')
    expect(error.model).toBeUndefined()
    expect(error.operation).toBeUndefined()
    expect(error.tenantId).toBeUndefined()
  })
})

describe('isTenantScopeError', () => {
  const error = new TenantScopeError('FOREIGN_RESULT', '别人的数据')

  it('认得出自己，并能按 reason 进一步收窄', () => {
    expect(isTenantScopeError(error)).toBe(true)
    expect(isTenantScopeError(error, 'FOREIGN_RESULT')).toBe(true)
    expect(isTenantScopeError(error, 'NO_CONTEXT')).toBe(false)
  })

  it('用鸭子类型而不是 instanceof：跨 ESM/CJS 双产物也认得出来', () => {
    // 模拟「同一个包被打了两份、instanceof 失效」的情形。
    const fromOtherCopy = { name: 'TenantScopeError', reason: 'NO_CONTEXT', message: 'x' }
    expect(fromOtherCopy instanceof TenantScopeError).toBe(false)
    expect(isTenantScopeError(fromOtherCopy, 'NO_CONTEXT')).toBe(true)
  })

  it.each([[null], [undefined], ['字符串'], [42], [new Error('普通错误')]])(
    '%s 不是 TenantScopeError',
    (value) => {
      expect(isTenantScopeError(value)).toBe(false)
    },
  )

  it('名字对但 reason 不是字符串时也不认', () => {
    expect(isTenantScopeError({ name: 'TenantScopeError', reason: 1 })).toBe(false)
  })
})
